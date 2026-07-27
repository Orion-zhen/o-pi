import { createHash } from "node:crypto";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadTypeScript } from "../benchmark/loader.mjs";

const args = process.argv.slice(2);
const size = readSize(args);
const fixture = readFixture(args);
const userId = typeof process.getuid === "function" ? process.getuid() : "user";
const temp = path.join(os.tmpdir(), `o-pi-repo-map-bench-${userId}-${fixture}-${size}`);
const workspace = path.join(temp, "repo");
const cacheRoot = path.join(temp, "cache");
const initialTime = new Date("2000-01-01T00:00:00.000Z");
const changedTime = new Date("2000-01-02T00:00:00.000Z");
const mutationTime = new Date("2000-01-03T00:00:00.000Z");

try {
	await rm(temp, { recursive: true, force: true });
	if (fixture === "modules") await writeModuleFixture(workspace, size, initialTime);
	else await writeTestDenseFixture(workspace, size, initialTime);

	const runtimeStarted = performance.now();
	const service = await loadTypeScript("src/repo-map/runtime/service.ts");
	const config = await loadTypeScript("src/repo-map/config/config.ts");
	const fileConfig = await loadTypeScript("src/file-tools/config.ts");
	const queryModule = await loadTypeScript("src/repo-map/query/file-tool-query.ts");
	const runtimeImported = performance.now();
	const impactModule = await loadTypeScript("src/repo-map/query/impact.ts");
	const tracker = stageTracker();
	const dependencies = benchmarkDependencies(workspace, cacheRoot, config, fileConfig, tracker);
	const result = fixture === "modules"
		? await runModuleFixture({ service, queryModule, impactModule, dependencies, tracker, runtimeImportMs: runtimeImported - runtimeStarted })
		: await runTestDenseFixture({ service, queryModule, impactModule, dependencies, tracker, runtimeImportMs: runtimeImported - runtimeStarted });
	console.log(JSON.stringify(result));
} finally {
	await rm(temp, { recursive: true, force: true });
}

async function runModuleFixture(context) {
	const { service, queryModule, impactModule, dependencies, tracker, runtimeImportMs } = context;
	const initial = await measureTracked(tracker, () => service.initializeRepoMap({ cwd: workspace }, dependencies));
	const initialMemory = process.memoryUsage();
	const unchanged = await measureTracked(tracker, () => service.initializeRepoMap({ cwd: workspace, mode: "refresh" }, dependencies));

	const targetIndex = Math.floor(size / 2);
	const targetPath = modulePath(targetIndex);
	await writeModule(workspace, targetIndex, changedSource(targetIndex), changedTime);
	const changed = await measureTracked(tracker, () => service.initializeRepoMap({ cwd: workspace, mode: "refresh" }, dependencies));
	const changedMemory = process.memoryUsage();

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
	const query = benchmarkQuery({ service, queryModule, impactModule, dependencies, tracker, branch });
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
	const mutationRefresh = await measureTracked(tracker, () => query.syncMutation({
		requestedPath: path.join(workspace, modulePath(mutationIndex)),
		changedLine: 2,
	}));
	if (mutationRefresh.value === undefined) throw new Error("Repo Map mutation benchmark did not refresh the map");
	const finalActivation = activationData(branch.at(-1));
	const finalGeneration = await service.readActivatedRepoMap(finalActivation, cacheRoot);
	assertGeneration(finalGeneration);

	const memory = process.memoryUsage();
	return {
		fixture: "modules",
		size,
		runtimeImportMs,
		initialBuildMs: initial.ms,
		noChangeRefreshMs: unchanged.ms,
		singleFileRefreshMs: changed.ms,
		coldGenerationReadMs: coldRead.ms,
		warmGenerationReadMs: warmRead.ms,
		firstQueryMs: firstQuery.ms,
		warmQueryMs: warmQuery.ms,
		readContextMs: readContext.ms,
		mutationRefreshMs: mutationRefresh.ms,
		mutationRepoMapRefreshMs: stage(mutationRefresh, "refresh"),
		mutationTestGraphMs: stage(mutationRefresh, "test-graph"),
		mutationGenerationReadMs: stage(mutationRefresh, "generation-read"),
		mutationGenerationCommitMs: stage(mutationRefresh, "generation-commit"),
		mutationImpactMs: stage(mutationRefresh, "impact"),
		heapUsedMb: memory.heapUsed / 1024 / 1024,
		rssMb: memory.rss / 1024 / 1024,
		initialRssMb: initialMemory.rss / 1024 / 1024,
		changedRssMb: changedMemory.rss / 1024 / 1024,
		rssGrowthMb: (changedMemory.rss - initialMemory.rss) / 1024 / 1024,
		generation: finalGeneration.metadata.generation,
		oracleDigest: digestModuleOracle(finalGeneration, firstQuery.value, readContext.value, mutationRefresh.value),
		counts: generationCounts(finalGeneration),
	};
}

async function runTestDenseFixture(context) {
	const { service, queryModule, impactModule, dependencies, tracker, runtimeImportMs } = context;
	const initial = await measureTracked(tracker, () => service.initializeRepoMap({ cwd: workspace }, dependencies));
	if (initial.value.metadata.freshness !== "partially_stale") throw new Error("stable-diagnostic fixture did not produce a partial generation");
	const initialGeneration = await service.readActivatedRepoMap({
		root: workspace,
		mapId: initial.value.metadata.mapId,
		generation: initial.value.metadata.generation,
	}, cacheRoot);
	assertStableSyntaxDiagnostic(initialGeneration);

	const unchanged = await measureTracked(tracker, () => service.initializeRepoMap({ cwd: workspace, mode: "refresh" }, dependencies));
	const branch = [activationEntry(unchanged.value.metadata)];
	const query = benchmarkQuery({ service, queryModule, impactModule, dependencies, tracker, branch });
	const targetIndex = Math.floor(size / 2);

	await writeModule(workspace, targetIndex, bodyMutationSource(targetIndex), changedTime);
	const sourceMutation = await measureTracked(tracker, () => query.syncMutation({
		requestedPath: path.join(workspace, modulePath(targetIndex)),
		changedLine: 2,
	}));
	if (sourceMutation.value === undefined) throw new Error("test-dense source mutation did not refresh the map");

	await writeStableFile(path.join(workspace, testPath(targetIndex)), mutatedTestSource(targetIndex), mutationTime);
	const testMutation = await measureTracked(tracker, () => query.syncMutation({
		requestedPath: path.join(workspace, testPath(targetIndex)),
		changedLine: 5,
	}));
	if (testMutation.value === undefined) throw new Error("test-dense test mutation did not refresh the map");

	const finalActivation = activationData(branch.at(-1));
	const finalGeneration = await service.readActivatedRepoMap(finalActivation, cacheRoot);
	assertStableSyntaxDiagnostic(finalGeneration);
	const semanticQuery = await query.query({
		requestedPath: path.join(workspace, modulePath(targetIndex)),
		query: targetName(targetIndex),
		limit: 12,
	});
	assertQuery(semanticQuery);

	return {
		fixture: "test-dense-stable-diagnostic",
		size,
		runtimeImportMs,
		initialBuildMs: initial.ms,
		unchangedPartialRefreshMs: unchanged.ms,
		unchangedPartialGenerationReadMs: stage(unchanged, "generation-read"),
		unchangedPartialTestGraphMs: stage(unchanged, "test-graph"),
		unchangedPartialGenerationCommitMs: stage(unchanged, "generation-commit"),
		sourceMutationMs: sourceMutation.ms,
		sourceRefreshMs: stage(sourceMutation, "refresh"),
		sourceGenerationReadMs: stage(sourceMutation, "generation-read"),
		sourceTestGraphMs: stage(sourceMutation, "test-graph"),
		sourceGenerationCommitMs: stage(sourceMutation, "generation-commit"),
		sourceImpactMs: stage(sourceMutation, "impact"),
		testMutationMs: testMutation.ms,
		testRefreshMs: stage(testMutation, "refresh"),
		testGenerationReadMs: stage(testMutation, "generation-read"),
		testTestGraphMs: stage(testMutation, "test-graph"),
		testGenerationCommitMs: stage(testMutation, "generation-commit"),
		testImpactMs: stage(testMutation, "impact"),
		stableDiagnosticCount: finalGeneration.diagnostics.filter((diagnostic) => diagnostic.code === "PARSER_SYNTAX_ERROR").length,
		generation: finalGeneration.metadata.generation,
		oracleDigest: digestTestDenseOracle({
			initial: initialGeneration,
			unchanged: unchanged.value,
			sourceMutation: sourceMutation.value,
			testMutation: testMutation.value,
			final: finalGeneration,
			query: semanticQuery,
		}),
		counts: generationCounts(finalGeneration),
	};
}

function benchmarkQuery({ service, queryModule, impactModule, dependencies, tracker, branch }) {
	return queryModule.createRepoMapFileToolQuery(() => branch, {
		readActivated: async (activation) => await tracker.measure("generation-read", async () =>
			await service.readActivatedRepoMap(activation, cacheRoot)),
		refresh: async (input) => await tracker.measure("refresh", async () =>
			await service.refreshActivatedRepoMap(input, dependencies)),
		analyzeImpact(input) {
			return tracker.measureSync("impact", () => impactModule.analyzeRepoMapImpact(input));
		},
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
}

function benchmarkDependencies(workspaceRoot, benchmarkCacheRoot, config, fileConfig, tracker) {
	const identity = {
		repositoryRoot: workspaceRoot,
		worktreeRoot: workspaceRoot,
		gitCommonDir: path.join(workspaceRoot, ".git"),
		headRevision: "a".repeat(40),
	};
	return {
		async detectRepository() { return identity; },
		async readHeadRevision() { return identity.headRevision; },
		async loadRepoMapConfig() { return config.defaultRepoMapConfig(); },
		async loadFileToolsConfig() { return fileConfig.defaultFileToolsConfig(); },
		async measureStage(stageName, operation) { return await tracker.measure(stageName, operation); },
		cacheRoot: () => benchmarkCacheRoot,
		now: () => new Date("2026-07-18T00:00:00.000Z"),
	};
}

function stageTracker() {
	let active;
	return {
		start() {
			if (active !== undefined) throw new Error("benchmark stage tracker is already active");
			active = new Map();
		},
		finish() {
			const result = active ?? new Map();
			active = undefined;
			return Object.fromEntries(result);
		},
		async measure(name, operation) {
			const started = performance.now();
			try {
				return await operation();
			} finally {
				if (active !== undefined) active.set(name, (active.get(name) ?? 0) + performance.now() - started);
			}
		},
		measureSync(name, operation) {
			const started = performance.now();
			try {
				return operation();
			} finally {
				if (active !== undefined) active.set(name, (active.get(name) ?? 0) + performance.now() - started);
			}
		},
	};
}

async function measureTracked(tracker, operation) {
	tracker.start();
	try {
		const measured = await measure(operation);
		return { ...measured, stages: tracker.finish() };
	} catch (error) {
		tracker.finish();
		throw error;
	}
}

function stage(measured, name) {
	return measured.stages[name] ?? 0;
}

async function writeModuleFixture(workspaceRoot, moduleCount, time) {
	await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
	await writeStableFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "repo-map-benchmark", type: "module" }), time);
	await writeModules(workspaceRoot, moduleCount, time);
}

async function writeTestDenseFixture(workspaceRoot, moduleCount, time) {
	await Promise.all([
		mkdir(path.join(workspaceRoot, "src"), { recursive: true }),
		mkdir(path.join(workspaceRoot, "tests", "fixtures"), { recursive: true }),
		mkdir(path.join(workspaceRoot, "tests", "__snapshots__"), { recursive: true }),
	]);
	await Promise.all([
		writeStableFile(path.join(workspaceRoot, "package.json"), JSON.stringify({
			name: "repo-map-test-dense-benchmark",
			type: "module",
			scripts: { test: "vitest --run" },
		}), time),
		writeStableFile(path.join(workspaceRoot, "vitest.config.ts"), "export default { test: { include: ['tests/**/*.test.ts'] } };\n", time),
		writeStableFile(path.join(workspaceRoot, "src", "stable-syntax-error.ts"), "export function StableSyntaxError( { return true; }\n", time),
	]);
	await writeModules(workspaceRoot, moduleCount, time);
	const concurrency = 32;
	for (let start = 0; start < moduleCount; start += concurrency) {
		await Promise.all(Array.from({ length: Math.min(concurrency, moduleCount - start) }, async (_, offset) => {
			const index = start + offset;
			await Promise.all([
				writeStableFile(path.join(workspaceRoot, testPath(index)), testSource(index), time),
				writeStableFile(path.join(workspaceRoot, fixturePath(index)), JSON.stringify({ value: index }), time),
				writeStableFile(path.join(workspaceRoot, snapshotPath(index)), `exports[${JSON.stringify(targetName(index))}] = ${JSON.stringify(index)};\n`, time),
			]);
		}));
	}
}

async function writeModules(workspaceRoot, moduleCount, time) {
	const concurrency = 64;
	for (let start = 0; start < moduleCount; start += concurrency) {
		await Promise.all(Array.from({ length: Math.min(concurrency, moduleCount - start) }, (_, offset) => {
			const index = start + offset;
			return writeModule(workspaceRoot, index, moduleSource(index), time);
		}));
	}
}

async function writeModule(workspaceRoot, index, source, time) {
	await writeStableFile(path.join(workspaceRoot, modulePath(index)), source, time);
}

async function writeStableFile(filePath, content, time) {
	await writeFile(filePath, content);
	await utimes(filePath, time, time);
}

function moduleSource(index) {
	const previous = index === 0 ? "" : `import { ${targetName(index - 1)} } from "./module-${pad(index - 1)}";\n`;
	const value = index === 0 ? String(index) : `${targetName(index - 1)}(value) + ${index}`;
	return `${previous}export function ${targetName(index)}(value = 0) { return ${value}; }\n`;
}

function changedSource(index) {
	return `${moduleSource(index)}export const Changed${pad(index)} = true;\n`;
}

function mutationSource(index) {
	return `${moduleSource(index)}export const Mutated${pad(index)} = "mutation";\n`;
}

function bodyMutationSource(index) {
	const previous = index === 0 ? "" : `import { ${targetName(index - 1)} } from "./module-${pad(index - 1)}";\n`;
	const value = index === 0 ? `${index} + value` : `${targetName(index - 1)}(value) + ${index} + 1`;
	return `${previous}export function ${targetName(index)}(value = 0) { return ${value}; }\n`;
}

function testSource(index) {
	return `import { ${targetName(index)} } from "../${modulePath(index)}";\nimport fixture from "./fixtures/module-${pad(index)}.json";\nvi.mock("../${modulePath(index)}");\ntest("${targetName(index)} uses fixture", () => { expect(${targetName(index)}(fixture.value)).toMatchSnapshot(); });\n`;
}

function mutatedTestSource(index) {
	return `${testSource(index)}test("${targetName(index)} handles mutation", () => { expect(${targetName(index)}(1)).toBeDefined(); });\n`;
}

function modulePath(index) {
	return `src/module-${pad(index)}.ts`;
}

function testPath(index) {
	return `tests/module-${pad(index)}.test.ts`;
}

function fixturePath(index) {
	return `tests/fixtures/module-${pad(index)}.json`;
}

function snapshotPath(index) {
	return `tests/__snapshots__/module-${pad(index)}.test.ts.snap`;
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
			...(metadata.freshness === "fresh" ? {} : { freshness: metadata.freshness }),
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

function assertStableSyntaxDiagnostic(generation) {
	assertGeneration(generation);
	if (!generation.diagnostics.some((diagnostic) => diagnostic.code === "PARSER_SYNTAX_ERROR" && diagnostic.path === "src/stable-syntax-error.ts")) {
		throw new Error("stable-diagnostic fixture omitted PARSER_SYNTAX_ERROR");
	}
}

function assertQuery(result) {
	if (result === undefined || result.candidates.length === 0) throw new Error("Repo Map query benchmark returned no candidates");
}

function digestModuleOracle(generation, query, context, mutation) {
	return digest({
		counts: generationCounts(generation),
		query: queryProjection(query),
		context,
		mutation: { status: mutation.status, candidates: mutation.impact?.candidates.length ?? 0 },
	});
}

function digestTestDenseOracle(input) {
	const testKinds = new Set(["tests", "mocks", "uses-fixture", "uses-snapshot", "configured-by"]);
	return digest({
		generations: {
			initial: input.initial.metadata.generation,
			unchanged: input.unchanged.metadata.generation,
			source: input.sourceMutation.generation,
			test: input.testMutation.generation,
			final: input.final.metadata.generation,
		},
		freshness: [input.initial.metadata.freshness, input.unchanged.metadata.freshness, input.final.metadata.freshness],
		counts: generationCounts(input.final),
		diagnostics: input.final.diagnostics.map((diagnostic) => ({ code: diagnostic.code, path: diagnostic.path })),
		testGraph: input.final.edges.filter((edge) => testKinds.has(edge.kind)).map((edge) => ({
			kind: edge.kind,
			from: edge.from,
			to: edge.to,
			source: edge.source,
			lexicalTarget: edge.lexicalTarget,
		})),
		query: queryProjection(input.query),
		sourceMutation: mutationProjection(input.sourceMutation),
		testMutation: mutationProjection(input.testMutation),
	});
}

function queryProjection(query) {
	return query.candidates.map((candidate) => ({
		path: candidate.path,
		symbol: candidate.symbol?.qualifiedName ?? candidate.symbol?.name,
		hop: candidate.hop,
		reasons: candidate.reasons,
	}));
}

function mutationProjection(mutation) {
	return {
		status: mutation.status,
		changedPath: mutation.impact?.changedPath,
		changedSymbols: mutation.impact?.changedSymbols ?? [],
		publicApiChanges: mutation.impact?.publicApiChanges ?? [],
		candidates: mutation.impact?.candidates.map((candidate) => ({
			path: candidate.path,
			symbol: candidate.symbol,
			role: candidate.role,
			impactReason: candidate.impactReason,
			graphDistance: candidate.graphDistance,
		})) ?? [],
	};
}

function generationCounts(generation) {
	return {
		files: generation.files.length,
		symbols: generation.symbols.length,
		tests: generation.tests.length,
		edges: generation.edges.length,
		aliases: generation.aliases.length,
	};
}

function digest(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readFixture(values) {
	const flag = values.find((arg) => arg.startsWith("--fixture="));
	const value = flag?.slice("--fixture=".length) ?? "modules";
	if (value !== "modules" && value !== "test-dense") throw new Error("--fixture must be modules or test-dense");
	return value;
}

function readSize(values) {
	const flag = values.find((arg) => arg.startsWith("--size="));
	const value = Number(flag?.slice("--size=".length) ?? 100);
	if (!Number.isInteger(value) || value < 2 || value > 100_000) throw new Error("--size must be an integer between 2 and 100000");
	return value;
}
