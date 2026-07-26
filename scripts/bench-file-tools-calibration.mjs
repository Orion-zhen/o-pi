import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadTypeScript, root } from "./benchmark/loader.mjs";
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "o-pi-ranking-calibration-"));
process.env.PI_REPO_MAP_CACHE_DIR = path.join(temporaryRoot, "cache");
process.env.PI_REPO_MAP_CONFIG = path.join(root, "agent/configs/repo-map.jsonc");
process.env.PI_FILE_TOOLS_CONFIG = path.join(root, "agent/configs/file-tools.jsonc");

const { initializeRepoMap, readActivatedRepoMap } = await loadTypeScript("src/repo-map/service.ts");
const { RepoMapQueryIndex } = await loadTypeScript("src/repo-map/query.ts");
const { FindTool } = await loadTypeScript("src/file-tools/find/command.ts");
const { FileToolsHost } = await loadTypeScript("src/file-tools/runtime/host.ts");
const { createFindGraphSource } = await loadTypeScript("src/file-tools/pi/adapters/find.ts");
const { GrepTool } = await loadTypeScript("src/file-tools/grep/command.ts");
const { createGrepGraphSource } = await loadTypeScript("src/file-tools/pi/adapters/grep.ts");

const findCases = [
	{ query: "ranking evidence", relevant: ["src/file-tools/shared/ranking/evidence.ts"] },
	{ query: "repo map ranking", relevant: ["src/file-tools/find/graph-ranking.ts", "src/file-tools/repo-map-ranking.ts"] },
	{ query: "file tool query", relevant: ["src/repo-map/file-tool-query.ts"] },
	{ query: "grep fusion", relevant: ["src/file-tools/grep/fusion.ts"] },
	{ query: "file tools ranking", relevant: ["docs/file-tools/ranking.md", "docs/file-tools/ranking-evidence.md", "docs/file-tools/ranking-selection.md"] },
];

const grepCases = [
	{ query: join("selectRelevance", "HeadMmr"), path: "src", match: "auto", relevant: ["src/file-tools/shared/ranking/selection.ts"] },
	{ query: join("repoMapRanking", "Evidence"), path: "src", match: "auto", relevant: ["src/file-tools/repo-map-ranking.ts"] },
	{ query: join("locateRepoMap", "Unit"), path: "src", match: "auto", relevant: ["src/file-tools/grep/command.ts"] },
	{ query: join("region", "Identity"), path: "src", match: "auto", relevant: ["src/file-tools/grep/fusion.ts"] },
	{ query: join("createRepoMapFileTool", "Query"), path: "src", match: "auto", relevant: ["src/repo-map/file-tool-query.ts"] },
	{
		query: join("not_", "guaranteed"),
		path: "src",
		match: "literal",
		relevant: ["src/file-tools/find/types.ts", "src/file-tools/find/guards.ts", "src/file-tools/find/command.ts", "src/file-tools/grep/packer.ts", "src/file-tools/grep/command.ts", "src/file-tools/grep/types.ts"],
	},
	{ query: join("RRF_", "K|MMR_", "LAMBDA"), path: "src", match: "regex", relevant: ["src/file-tools/shared/ranking/evidence.ts", "src/file-tools/shared/ranking/selection.ts"] },
	{ query: join("callers of selectRelevance", "HeadMmr"), path: "src", match: "auto", relevant: ["src/file-tools/find/fusion.ts", "src/file-tools/grep/fusion.ts"] },
	{ query: join("selectRelevanceHead", "Mmr tests"), path: "tests", match: "auto", relevant: ["tests/file-tools/ranking-selection.test.ts"] },
];

const findHost = new FileToolsHost();
const findTool = new FindTool();
const grepHost = new FileToolsHost();
let grepTool = new GrepTool();

try {
	const buildStarted = performance.now();
	const initialized = await initializeRepoMap({ cwd: root, mode: "rebuild" });
	const buildMs = performance.now() - buildStarted;
	const generation = await readActivatedRepoMap({
		root: initialized.metadata.repositoryRoot,
		mapId: initialized.metadata.mapId,
		generation: initialized.metadata.generation,
	}, process.env.PI_REPO_MAP_CACHE_DIR);
	if (generation === undefined) throw new Error("calibration Repo Map generation could not be read");
	const queryIndex = new RepoMapQueryIndex(generation);
	const repoMap = {
		async query(input) { return queryIndex.candidates(input.query, input.limit); },
		async readContext() { return undefined; },
		async syncMutation() { return undefined; },
	};

	const rows = [];
	for (const calibration of findCases) {
		const started = performance.now();
		const opened = await findHost.open({ cwd: root, sessionId: "calibration-find" });
		if (opened.status === "failed") throw new Error(`find host failed for ${calibration.query}: ${opened.error.message}`);
		let result;
		try {
			result = await findTool.execute({ query: calibration.query }, {
				filesystem: opened.filesystem,
				operation: opened.context,
				limits: opened.limits,
				graph: createFindGraphSource({ query: repoMap }, opened),
			});
		} finally {
			opened.dispose();
		}
		if ("status" in result) throw new Error(`find failed for ${calibration.query}: ${result.error.message}`);
		rows.push(calibrationRow("find", calibration, result.details.matches.map((match) => match.path), performance.now() - started));
	}
	for (const calibration of grepCases) {
		grepTool.dispose();
		grepTool = new GrepTool();
		const started = performance.now();
		const opened = await grepHost.open({ cwd: root, sessionId: "calibration-grep" });
		if (opened.status === "failed") throw new Error(`grep host failed for ${calibration.query}: ${opened.error.message}`);
		let result;
		try {
			result = await grepTool.execute({ query: calibration.query, path: [calibration.path], match: calibration.match }, {
				filesystem: opened.filesystem,
				operation: opened.context,
				limits: opened.limits,
				graph: createGrepGraphSource({ query: repoMap }, opened),
			});
		} finally { opened.dispose(); }
		if (result.status === "failed") throw new Error(`grep failed for ${calibration.query}: ${result.error.message}`);
		rows.push(calibrationRow("grep", calibration, result.regions.map((region) => region.path), performance.now() - started));
	}

	const meanReciprocalRank = mean(rows.map((row) => row.reciprocalRank));
	const recallAt3 = mean(rows.map((row) => Number(row.rank !== undefined && row.rank <= 3)));
	console.log(`o-pi repository ranking calibration (${generation.files.length} files, ${generation.symbols.length} symbols, Repo Map build ${round(buildMs)} ms)`);
	console.table(rows.map(({ reciprocalRank: _reciprocalRank, ...row }) => row));
	console.log(`MRR=${round(meanReciprocalRank)} · Recall@3=${round(recallAt3)} · cases=${rows.length}`);
	if (meanReciprocalRank < 0.95 || recallAt3 < 0.95) {
		throw new Error("current-repository ranking calibration fell below MRR/Recall@3 threshold 0.95");
	}
} finally {
	findTool.dispose();
	findHost.dispose();
	grepTool.dispose();
	grepHost.dispose();
	await rm(temporaryRoot, { recursive: true, force: true });
}

function calibrationRow(tool, calibration, paths, elapsedMs) {
	const relevant = new Set(calibration.relevant);
	const index = paths.findIndex((filePath) => relevant.has(filePath));
	const rank = index === -1 ? undefined : index + 1;
	return {
		tool,
		query: calibration.query,
		rank,
		"top-3": paths.slice(0, 3).join(" · "),
		"ms": round(elapsedMs),
		reciprocalRank: rank === undefined ? 0 : 1 / rank,
	};
}

function mean(values) {
	return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function join(...parts) {
	return parts.join("");
}

function round(value) {
	return Math.round(value * 100) / 100;
}
