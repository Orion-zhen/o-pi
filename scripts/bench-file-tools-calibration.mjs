import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadTypeScript } from "./benchmark/loader.mjs";

const root = process.cwd();
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "o-pi-ranking-calibration-"));
process.env.PI_REPO_MAP_CACHE_DIR = path.join(temporaryRoot, "cache");

const { initializeRepoMap, readActivatedRepoMap } = await loadTypeScript("src/repo-map/runtime/service.ts");
const { RepoMapQueryIndex } = await loadTypeScript("src/repo-map/query/query.ts");
const { FileToolsHost } = await loadTypeScript("src/file-tools/runtime/host.ts");
const { createRepoMapGrepHintSource } = await loadTypeScript("src/file-tools/pi/adapters/grep.ts");
const { GrepTool } = await loadTypeScript("src/file-tools/grep/command.ts");

const cases = [
	{ kind: "identifier", query: "rankCodeRegions", path: "src", match: "auto", relevant: ["src/file-tools/grep/ranking.ts"] },
	{ kind: "qualified", query: "GrepTool.execute", path: "src", match: "auto", relevant: ["src/file-tools/grep/command.ts"] },
	{ kind: "error", query: "AST file byte limit must be a non-negative safe integer.", path: "src", match: "auto", relevant: ["src/file-tools/grep/regionizer.ts"] },
	{ kind: "natural", query: "source local ranks are assigned", path: "src/file-tools/grep", match: "auto", relevant: ["src/file-tools/grep/ranking.ts", "src/file-tools/grep/local.ts", "src/file-tools/grep/hints.ts", "src/file-tools/grep/regionizer.ts"] },
	{ kind: "caller", query: "callers of rankCodeRegions", path: "src/file-tools/grep", match: "auto", relevant: ["src/file-tools/grep/local.ts", "src/file-tools/grep/hints.ts", "src/file-tools/grep/command.ts"] },
	{ kind: "test", query: "tests for rankCodeRegions", path: "tests/file-tools", match: "auto", relevant: ["tests/file-tools/grep-query-ranking.test.ts"] },
	{ kind: "import", query: "where ranking is imported", path: "src/file-tools/grep", match: "auto", relevant: ["src/file-tools/grep/local.ts", "src/file-tools/grep/hints.ts", "src/file-tools/grep/command.ts", "src/file-tools/grep/regionizer.ts"] },
	{ kind: "literal", query: "not_guaranteed", path: "src/file-tools/grep", match: "literal", relevant: ["src/file-tools/grep/types.ts", "src/file-tools/grep/local.ts"] },
	{ kind: "regex", query: "GREP_(?:RRF_K|SOURCE_WEIGHTS)", path: "src/file-tools/grep", match: "regex", relevant: ["src/file-tools/grep/ranking.ts"] },
];

const host = new FileToolsHost();
const tool = new GrepTool();

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
	for (const calibration of cases) {
		const started = performance.now();
		const opened = await host.open({ cwd: root, sessionId: `calibration-${calibration.kind}` });
		if (opened.status === "failed") throw new Error(`grep host failed for ${calibration.query}: ${opened.error.message}`);
		let result;
		try {
			result = await tool.execute({ query: calibration.query, path: [calibration.path], match: calibration.match }, {
				filesystem: opened.filesystem,
				operation: opened.context,
				limits: opened.limits,
				repoMapHints: createRepoMapGrepHintSource({ query: repoMap }, opened),
			});
		} finally {
			opened.dispose();
		}
		if (result.status === "failed") throw new Error(`grep failed for ${calibration.query}: ${result.error.message}`);
		rows.push(calibrationRow(calibration, result.regions, performance.now() - started));
	}

	const meanReciprocalRank = mean(rows.map((row) => row.reciprocalRank));
	const recallAt3 = mean(rows.map((row) => row.recallAt3));
	const fileHitAt3 = mean(rows.map((row) => row.fileHitAt3));
	console.log(`o-pi grep ranking calibration (${generation.files.length} files, ${generation.symbols.length} symbols, Repo Map build ${round(buildMs)} ms)`);
	console.table(rows.map(({ reciprocalRank: _reciprocalRank, recallAt3: _recallAt3, fileHitAt3: _fileHitAt3, ...row }) => row));
	console.log(`MRR=${round(meanReciprocalRank)} · Recall@3=${round(recallAt3)} · FileHit@3=${round(fileHitAt3)} · cases=${rows.length}`);
	if (meanReciprocalRank < 0.95 || recallAt3 < 0.95) {
		throw new Error("current-repository grep ranking calibration fell below MRR/Recall@3 threshold 0.95");
	}
} finally {
	tool.dispose();
	host.dispose();
	await rm(temporaryRoot, { recursive: true, force: true });
}

function calibrationRow(calibration, regions, elapsedMs) {
	const relevant = new Set(calibration.relevant);
	const firstIndex = regions.findIndex((region) => relevant.has(region.path));
	const firstRelevantRank = firstIndex === -1 ? undefined : firstIndex + 1;
	const top3 = regions.slice(0, 3);
	const relevantRegionsAt3 = top3.filter((region) => relevant.has(region.path)).length;
	const recallAt3 = Number(firstRelevantRank !== undefined && firstRelevantRank <= 3);
	return {
		kind: calibration.kind,
		query: calibration.query,
		firstRelevantRank,
		"top-3": top3.map((region) => `${region.path}:${region.start_line}`).join(" · "),
		"region-recall@3": round(relevantRegionsAt3 / Math.max(1, Math.min(3, regions.filter((region) => relevant.has(region.path)).length))),
		"ms": round(elapsedMs),
		reciprocalRank: firstRelevantRank === undefined ? 0 : 1 / firstRelevantRank,
		recallAt3,
		fileHitAt3: recallAt3,
	};
}

function mean(values) {
	return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function round(value) {
	return Math.round(value * 100) / 100;
}
