import { createHash } from "node:crypto";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const size = readSize(process.argv.slice(2));
const userId = typeof process.getuid === "function" ? process.getuid() : "user";
const temp = path.join(os.tmpdir(), `o-pi-repo-map-bench-${userId}-${size}`);
const workspace = path.join(temp, "repo");
const cacheRoot = path.join(temp, "cache");
const initialTime = new Date("2000-01-01T00:00:00.000Z");
const changedTime = new Date("2000-01-02T00:00:00.000Z");
const mutationTime = new Date("2000-01-03T00:00:00.000Z");

try {
	await rm(temp, { recursive: true, force: true });
	await writeFixture(workspace, size, initialTime);
	const runtimeStarted = performance.now();
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const service = await jiti.import(fileURLToPath(new URL("../src/repo-map/service.ts", import.meta.url)));
	const config = await jiti.import(fileURLToPath(new URL("../src/repo-map/config.ts", import.meta.url)));
	const fileConfig = await jiti.import(fileURLToPath(new URL("../src/file-tools/config.ts", import.meta.url)));
	const queryModule = await jiti.import(fileURLToPath(new URL("../src/repo-map/file-tool-query.ts", import.meta.url)));
	const runtimeImported = performance.now();

	const dependencies = benchmarkDependencies(workspace, cacheRoot, config, fileConfig);
	const initial = await measure(() => service.initializeRepoMap({ cwd: workspace }, dependencies));
	const unchanged = await measure(() => service.initializeRepoMap({ cwd: workspace, mode: "refresh" }, dependencies));

	const targetIndex = Math.floor(size / 2);
	const targetPath = modulePath(targetIndex);
	await writeModule(workspace, targetIndex, changedSource(targetIndex), changedTime);
	const changed = await measure(() => service.initializeRepoMap({ cwd: workspace, mode: "refresh" }, dependencies));

	const coldRead = await measure(() => service.readActivatedRepoMap({
		root: workspace,
		mapId: changed.value.metadata.mapId,
		generation: changed.value.metadata.generation,
	}, cacheRoot));
	assertGeneration(coldRead.value);
	const warmRead = await measure(() => service.readActivatedRepoMap({
		root: workspace,
		mapId: changed.value.metadata.mapId,
		generation: changed.value.metadata.generation,
	}, cacheRoot));
	assertGeneration(warmRead.value);

	const branch = [activationEntry(changed.value.metadata)];
	const query = queryModule.createRepoMapFileToolQuery(() => branch, {
		readActivated: async (activation) => await service.readActivatedRepoMap(activation, cacheRoot),
		refresh: async (input) => await service.initializeRepoMap({
			cwd: input.activation.root,
			mode: "refresh",
			...(input.signal === undefined ? {} : { signal: input.signal }),
		}, dependencies),
		appendActivation(entry) {
			branch.push({
				type: "custom",
				id: `activation-${branch.length}`,
				parentId: null,
				timestamp: entry.activatedAt,
				customType: "o-pi:repo-map",
				data: entry,
			});
		},
		now: () => new Date("2026-07-18T00:00:00.000Z"),
	});
	const queryInput = { requestedPath: path.join(workspace, targetPath), query: targetName(targetIndex), limit: 8 };
	const firstQuery = await measure(() => query.query(queryInput));
	assertQuery(firstQuery.value);
	const warmQuery = await measure(() => query.query(queryInput));
	assertQuery(warmQuery.value);

	const targetFile = coldRead.value.files.find((file) => file.path === targetPath);
	const targetSymbol = coldRead.value.symbols.find((symbol) => symbol.fileId === targetFile?.id && symbol.name === targetName(targetIndex));
	if (targetFile?.contentHash === undefined || targetSymbol === undefined) throw new Error("benchmark target was not indexed");
	const readContext = await measure(() => query.readContext({
		requestedPath: path.join(workspace, targetPath),
		contentHash: targetFile.contentHash,
		startLine: targetSymbol.startLine,
		endLine: targetSymbol.endLine,
		partial: true,
		truncated: false,
	}));
	if (readContext.value === undefined) throw new Error("Repo Map read context benchmark returned no context");

	const mutationIndex = Math.min(size - 1, targetIndex + 1);
	await writeModule(workspace, mutationIndex, mutationSource(mutationIndex), mutationTime);
	const mutationRefresh = await measure(() => query.syncMutation({
		requestedPath: path.join(workspace, modulePath(mutationIndex)),
		changedLine: 2,
	}));
	if (mutationRefresh.value === undefined) throw new Error("Repo Map mutation benchmark did not refresh the map");
	const finalActivation = activationData(branch.at(-1));
	const finalGeneration = await service.readActivatedRepoMap(finalActivation, cacheRoot);
	assertGeneration(finalGeneration);

	const memory = process.memoryUsage();
	console.log(JSON.stringify({
		size,
		runtimeImportMs: runtimeImported - runtimeStarted,
		initialBuildMs: initial.ms,
		noChangeRefreshMs: unchanged.ms,
		singleFileRefreshMs: changed.ms,
		coldGenerationReadMs: coldRead.ms,
		warmGenerationReadMs: warmRead.ms,
		firstQueryMs: firstQuery.ms,
		warmQueryMs: warmQuery.ms,
		readContextMs: readContext.ms,
		mutationRefreshMs: mutationRefresh.ms,
		heapUsedMb: memory.heapUsed / 1024 / 1024,
		rssMb: memory.rss / 1024 / 1024,
		generation: finalGeneration.metadata.generation,
		oracleDigest: digestOracle(finalGeneration, firstQuery.value, readContext.value, mutationRefresh.value),
		counts: {
			files: finalGeneration.files.length,
			symbols: finalGeneration.symbols.length,
			tests: finalGeneration.tests.length,
			edges: finalGeneration.edges.length,
			aliases: finalGeneration.aliases.length,
		},
	}));
} finally {
	await rm(temp, { recursive: true, force: true });
}

function benchmarkDependencies(workspace, cacheRoot, config, fileConfig) {
	const identity = {
		repositoryRoot: workspace,
		worktreeRoot: workspace,
		gitCommonDir: path.join(workspace, ".git"),
		headRevision: "a".repeat(40),
	};
	const ignoreSnapshot = {
		generation: 1,
		fingerprint: "repo-map-benchmark-ignore-v1",
		diagnostics: [],
		evaluate() { return { state: "none", ignored: false, prune: false }; },
		explain(input) { return { path: input.path, ignored: false, prune: false, trace: [] }; },
	};
	return {
		async detectRepository() { return identity; },
		async readHeadRevision() { return identity.headRevision; },
		async loadRepoMapConfig() { return config.defaultRepoMapConfig(); },
		async loadFileToolsConfig() { return fileConfig.defaultFileToolsConfig(); },
		async createIgnoreSnapshot() { return ignoreSnapshot; },
		cacheRoot: () => cacheRoot,
		now: () => new Date("2026-07-18T00:00:00.000Z"),
	};
}

async function writeFixture(workspace, size, time) {
	await mkdir(path.join(workspace, "src"), { recursive: true });
	await writeStableFile(path.join(workspace, "package.json"), JSON.stringify({ name: "repo-map-benchmark", type: "module" }), time);
	const concurrency = 64;
	for (let start = 0; start < size; start += concurrency) {
		await Promise.all(Array.from({ length: Math.min(concurrency, size - start) }, (_, offset) => {
			const index = start + offset;
			return writeModule(workspace, index, moduleSource(index), time);
		}));
	}
}

async function writeModule(workspace, index, source, time) {
	await writeStableFile(path.join(workspace, modulePath(index)), source, time);
}

async function writeStableFile(filePath, content, time) {
	await writeFile(filePath, content);
	await utimes(filePath, time, time);
}

function moduleSource(index) {
	const previous = index === 0 ? "" : `import { ${targetName(index - 1)} } from \"./module-${pad(index - 1)}\";\n`;
	const value = index === 0 ? String(index) : `${targetName(index - 1)}(value) + ${index}`;
	return `${previous}export function ${targetName(index)}(value = 0) { return ${value}; }\n`;
}

function changedSource(index) {
	return `${moduleSource(index)}export const Changed${pad(index)} = true;\n`;
}

function mutationSource(index) {
	return `${moduleSource(index)}export const Mutated${pad(index)} = \"mutation\";\n`;
}

function modulePath(index) {
	return `src/module-${pad(index)}.ts`;
}

function targetName(index) {
	return `Target${pad(index)}`;
}

function pad(index) {
	return String(index).padStart(5, "0");
}

function activationEntry(metadata) {
	return {
		type: "custom",
		id: "activation-0",
		parentId: null,
		timestamp: metadata.updatedAt,
		customType: "o-pi:repo-map",
		data: {
			kind: "activation",
			root: metadata.repositoryRoot,
			mapId: metadata.mapId,
			generation: metadata.generation,
			activatedAt: metadata.updatedAt,
		},
	};
}

function activationData(entry) {
	const value = entry?.data;
	if (value?.kind !== "activation") throw new Error("benchmark activation was not updated");
	return value;
}

async function measure(operation) {
	const started = performance.now();
	const value = await operation();
	return { ms: performance.now() - started, value };
}

function assertGeneration(generation) {
	if (generation === undefined) throw new Error("Repo Map generation benchmark could not read the generation");
}

function assertQuery(result) {
	if (result === undefined || result.candidates.length === 0) throw new Error("Repo Map query benchmark returned no candidates");
}

function digestOracle(generation, query, context, mutation) {
	const projection = {
		counts: {
			files: generation.files.length,
			symbols: generation.symbols.length,
			tests: generation.tests.length,
			edges: generation.edges.length,
			aliases: generation.aliases.length,
		},
		query: query.candidates.map((candidate) => ({
			path: candidate.path,
			symbol: candidate.symbol?.qualifiedName ?? candidate.symbol?.name,
			hop: candidate.hop,
			reasons: candidate.reasons,
		})),
		context,
		mutation: { status: mutation.status, candidates: mutation.impact?.candidates.length ?? 0 },
	};
	return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

function readSize(args) {
	const flag = args.find((arg) => arg.startsWith("--size="));
	const value = Number(flag?.slice("--size=".length) ?? 100);
	if (!Number.isInteger(value) || value < 2 || value > 100_000) throw new Error("--size must be an integer between 2 and 100000");
	return value;
}
