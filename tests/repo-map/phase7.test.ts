import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultFileToolsConfig } from "../../src/file-tools/config.js";
import { createIgnoreSnapshot, defaultIgnoreEngine } from "../../src/file-tools/ignore/ignore-engine.js";
import { formatEditModelResult, formatWriteModelResult } from "../../src/file-tools/pi/model-output.js";
import { REPO_MAP_SESSION_ENTRY } from "../../src/repo-map/activation.js";
import { buildRepoMapArchitecture } from "../../src/repo-map/architecture-indexer.js";
import { defaultRepoMapConfig } from "../../src/repo-map/config.js";
import { createRepoMapFileToolQuery } from "../../src/repo-map/file-tool-query.js";
import { compareRepoMapEdge } from "../../src/repo-map/graph-types.js";
import { analyzeRepoMapImpact } from "../../src/repo-map/impact.js";
import { RepoMapQueryIndex } from "../../src/repo-map/query.js";
import { buildRepoMapRelationships } from "../../src/repo-map/relationship-indexer.js";
import { initializeRepoMap, readActivatedRepoMap, type InitializeRepoMapResult, type RepoMapServiceDependencies } from "../../src/repo-map/service.js";
import type { RepoMapGeneration } from "../../src/repo-map/storage.js";
import { indexRepoMapSymbols } from "../../src/repo-map/symbol-indexer.js";
import { buildRepoMapTestGraph } from "../../src/repo-map/test-indexer.js";
import type { RepoMapFileRecord, RepoMapMetadata } from "../../src/repo-map/types.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-repo-phase7-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(async () => {
	const configPath = path.join(temp.path, "file-tools.jsonc");
	await writeFile(configPath, JSON.stringify({
		version: 1,
		blocked_path: [".git/"],
		ignored_path: [],
		ignore: { builtin_profile: "none", gitignore: false },
		limits: { read_lines: 40, read_bytes: 16_384, find_result_limit: 30, grep_result_limit: 30 },
	}));
	process.env.PI_FILE_TOOLS_CONFIG = configPath;
});

describe("Repo Map Phase 7 test graph and change impact", () => {
	it("indexes named tests, imports, mocks, fixtures, snapshots, and runner configuration with evidence", async () => {
		const generation = await generationFromSources(temp.path, fixtureSources("export function loadUser() { return 'user'; }\n"), "1");
		expect(generation.tests).toEqual(expect.arrayContaining([
			expect.objectContaining({ testKind: "file", name: "tests/user.test.ts", source: "convention" }),
			expect.objectContaining({ testKind: "symbol", name: "loadUser returns a user", source: "syntax" }),
		]));
		for (const kind of ["tests", "mocks", "uses-fixture", "uses-snapshot", "configured-by"] as const) {
			expect(generation.edges.some((edge) => edge.kind === kind)).toBe(true);
		}
		expect(generation.edges).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "tests", to: "file:src/user.ts", source: "tree-sitter", resolution: "syntactic" }),
			expect.objectContaining({ kind: "mocks", to: "file:src/user.ts", lexicalTarget: "../src/user" }),
			expect.objectContaining({ kind: "uses-fixture", to: "file:tests/fixtures/user.json" }),
			expect.objectContaining({ kind: "uses-snapshot", to: "file:tests/__snapshots__/user.test.ts.snap" }),
			expect.objectContaining({ kind: "configured-by", to: "file:vitest.config.ts" }),
			expect.objectContaining({ kind: "configured-by", to: "file:package.json", source: "manifest" }),
		]));
		const testEdges = generation.edges.filter((edge) => ["tests", "mocks", "uses-fixture", "uses-snapshot", "configured-by"].includes(edge.kind));
		expect(testEdges.every((edge) => edge.evidence.length > 0 && edge.evidence.every((evidence) => evidence.path.length > 0) && edge.confidence > 0)).toBe(true);

		const query = new RepoMapQueryIndex(generation).candidates("loadUser", 30).candidates;
		expect(query).toContainEqual(expect.objectContaining({ path: "tests/user.test.ts", reasons: expect.arrayContaining(["test"]) }));
		const fromTest = new RepoMapQueryIndex(generation).candidates("tests/user.test.ts", 30).candidates;
		expect(fromTest.map((candidate) => candidate.path)).toEqual(expect.arrayContaining(["src/user.ts", "tests/fixtures/user.json", "tests/__snapshots__/user.test.ts.snap"]));
	});

	it("ranks callers, public API dependents, importers, tests, entrypoints, and bounded component candidates", async () => {
		const before = await generationFromSources(temp.path, fixtureSources("export function loadUser() { return 'user'; }\n"), "1");
		const after = await generationFromSources(temp.path, fixtureSources("export function loadUser(id: string) { return id; }\n"), "2");
		const impact = analyzeRepoMapImpact({ before, after, changedPath: "src/user.ts", maxCandidates: 10 });
		expect(impact.candidate).toBe(true);
		expect(impact.changedSymbols).toContainEqual(expect.stringContaining("loadUser"));
		expect(impact.publicApiChanges).toContainEqual(expect.stringContaining("loadUser"));
		expect(impact.candidates).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: "src/user.ts", impactReason: expect.stringContaining("directly changed"), graphDistance: 0 }),
			expect.objectContaining({ path: "src/caller.ts", role: "caller", impactReason: "direct caller", graphDistance: 1 }),
			expect.objectContaining({ path: "src/caller.ts", role: "public-api", impactReason: "depends on changed public API" }),
			expect.objectContaining({ path: "tests/user.test.ts", role: "test", impactReason: "explicit test relation" }),
		]));
		expect(impact.candidates.every((candidate) => candidate.evidence.length > 0 && candidate.graphDistance <= 2)).toBe(true);
		expect(impact.candidates.length).toBeLessThanOrEqual(10);
		expect(impact.candidates.findIndex((candidate) => candidate.role === "caller"))
			.toBeLessThan(impact.candidates.findIndex((candidate) => candidate.role === "test"));
		const tightlyBounded = analyzeRepoMapImpact({ before, after, changedPath: "src/user.ts", maxCandidates: 3 });
		expect(tightlyBounded.candidates).toHaveLength(3);
		const bodyOnly = await generationFromSources(temp.path, fixtureSources("export function loadUser() { return 'changed body'; }\n"), "4");
		const bodyImpact = analyzeRepoMapImpact({ before, after: bodyOnly, changedPath: "src/user.ts", changedLine: 1 });
		expect(bodyImpact.changedSymbols).toContain("modified function loadUser");
		expect(bodyImpact.publicApiChanges).toEqual([]);
	});

	it("persists test nodes in generation hash and removes deleted test resources without dangling edges", async () => {
		const root = path.join(temp.path, "incremental");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeSources(root, fixtureSources("export function loadUser() { return 'user'; }\n"));
		const first = await initializeRepoMap({ cwd: root }, serviceDependencies(root));
		const initial = await persistedGeneration(root, first.metadata.mapId, first.metadata.generation);
		expect(initial.metadata.schemaVersion).toBe(5);
		expect(initial.metadata.testNodeCount).toBe(initial.tests.length);
		expect(initial.tests.length).toBeGreaterThan(1);
		const testsSnapshot = JSON.parse(await readFile(path.join(temp.path, "cache", first.metadata.mapId, "generations", first.metadata.generation, "tests.json"), "utf8")) as unknown[];
		expect(testsSnapshot.length).toBe(initial.tests.length);

		await rm(path.join(root, "tests"), { recursive: true });
		const refreshed = await initializeRepoMap({ cwd: root, mode: "refresh" }, serviceDependencies(root));
		const current = await persistedGeneration(root, refreshed.metadata.mapId, refreshed.metadata.generation);
		expect(refreshed.metadata.generation).not.toBe(first.metadata.generation);
		expect(current.tests).toEqual([]);
		expect(JSON.stringify(current)).not.toContain("tests/user.test.ts");
		const ids = new Set([`repository:${current.metadata.mapId}`, ...current.files.map((file) => file.id), ...current.symbols.map((symbol) => symbol.id), ...current.tests.map((node) => node.id), ...current.architecture.map((node) => node.id)]);
		expect(current.edges.every((edge) => ids.has(edge.from) && (ids.has(edge.to) || edge.to.startsWith("external:") || edge.to.startsWith("lexical:")))).toBe(true);
	});

	it("attaches hash-verified compact mutation impact, while inactive or failed analysis stays non-blocking", async () => {
		const beforeSources = fixtureSources("export function loadUser() { return 'user'; }\n");
		const afterSources = fixtureSources("export function loadUser(id: string) { return id; }\n");
		const before = await generationFromSources(temp.path, beforeSources, "1");
		const after = await generationFromSources(temp.path, afterSources, "2");
		await writeSources(temp.path, afterSources);
		const branch = [activationEntry(before)];
		const refresh = vi.fn(async () => initializeResult(after));
		const readActivated = vi.fn(async (activation: { generation: string }) => activation.generation === before.metadata.generation ? before : after);
		const analyzeImpactSpy = vi.fn(analyzeRepoMapImpact);
		const query = createRepoMapFileToolQuery(() => branch, { readActivated, refresh, analyzeImpact: analyzeImpactSpy });
		const mutation = await query.syncMutation({ requestedPath: path.join(temp.path, "src/user.ts"), changedLine: 1 });
		expect(mutation).toMatchObject({ status: "updated", impact: { candidate: true, changedPath: "src/user.ts" } });
		expect(analyzeImpactSpy).toHaveBeenCalledWith(expect.objectContaining({ changedLine: 1, maxCandidates: 8 }));
		if (mutation === undefined) throw new Error("missing mutation result");
		expect(mutation?.impact?.candidates).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: "src/caller.ts", role: "caller" }),
			expect.objectContaining({ path: "tests/user.test.ts", role: "test" }),
		]));
		const writeText = formatWriteModelResult({ status: "written", path: "src/user.ts", bytes: 1, diff: "", repo_map: mutation });
		const editText = formatEditModelResult({ status: "applied", path: "src/user.ts", replacements: 1, old_version: "old", new_version: "new", diff: "", repo_map: mutation });
		for (const text of [writeText, editText]) {
			expect(text).toContain('<repo-impact candidate="true"');
			expect(text).toContain('tests="tests/user.test.ts"');
			expect(text.length).toBeLessThan(1_000);
		}

		const analyzeImpact = vi.fn(() => { throw new Error("simulated analysis failure"); });
		const failing = createRepoMapFileToolQuery(() => branch, { readActivated, refresh, analyzeImpact });
		expect(await failing.syncMutation({ requestedPath: path.join(temp.path, "src/user.ts") }))
			.toEqual({ status: "updated", generation: after.metadata.generation });
		const inactiveRefresh = vi.fn(async () => initializeResult(after));
		const inactiveRead = vi.fn(async () => before);
		const inactiveAnalyze = vi.fn(analyzeRepoMapImpact);
		const inactive = createRepoMapFileToolQuery(() => [], { readActivated: inactiveRead, refresh: inactiveRefresh, analyzeImpact: inactiveAnalyze });
		expect(await inactive.syncMutation({ requestedPath: path.join(temp.path, "src/user.ts") })).toBeUndefined();
		expect(inactiveRead).not.toHaveBeenCalled();
		expect(inactiveRefresh).not.toHaveBeenCalled();
		expect(inactiveAnalyze).not.toHaveBeenCalled();
	});

	it("drops related test candidates when their live hash no longer matches", async () => {
		const sources = fixtureSources("export function loadUser() { return 'user'; }\n");
		await writeSources(temp.path, sources);
		const generation = await generationFromSources(temp.path, sources, "3");
		const active = createRepoMapFileToolQuery(() => [activationEntry(generation)], { readActivated: async () => generation });
		const userHash = generation.files.find((file) => file.path === "src/user.ts")?.contentHash;
		if (userHash === undefined) throw new Error("missing user hash");
		const readContext = await active.readContext({ requestedPath: path.join(temp.path, "src/user.ts"), contentHash: userHash, startLine: 1, endLine: 1, partial: true, truncated: false });
		expect(readContext?.relatedTests).toContain("tests/user.test.ts");
		const fresh = await active.query({ requestedPath: temp.path, query: "loadUser", limit: 30 });
		expect(fresh?.candidates.map((candidate) => candidate.path)).toContain("tests/user.test.ts");
		await writeFile(path.join(temp.path, "tests/user.test.ts"), "test('changed', () => true);\n");
		const stale = await active.query({ requestedPath: temp.path, query: "loadUser", limit: 30 });
		expect(stale?.candidates.map((candidate) => candidate.path)).not.toContain("tests/user.test.ts");
	});
});

function fixtureSources(userSource: string): Map<string, string> {
	return new Map([
		["package.json", JSON.stringify({ name: "phase-seven", exports: "./src/user.ts", scripts: { test: "vitest --run" } })],
		["vitest.config.ts", "export default { test: { include: ['tests/**/*.test.ts'] } };\n"],
		["src/user.ts", userSource],
		["src/caller.ts", "import { loadUser } from './user';\nexport function renderUser() { return loadUser(); }\n"],
		["src/neighbor.ts", "export function neighbor() { return true; }\n"],
		["tests/user.test.ts", [
			"import { loadUser } from '../src/user';",
			"import fixture from './fixtures/user.json';",
			"vi.mock('../src/user');",
			"describe('user service', () => {",
			"  test('loadUser returns a user', () => { expect(loadUser()).toMatchSnapshot('user snapshot'); });",
			"});",
			"void fixture;",
		].join("\n")],
		["tests/fixtures/user.json", "{\"name\":\"fixture\"}\n"],
		["tests/__snapshots__/user.test.ts.snap", "exports[`user snapshot 1`] = `user`;\n"],
	]);
}

async function generationFromSources(root: string, sources: ReadonlyMap<string, string>, generationCharacter: string): Promise<RepoMapGeneration> {
	const files = [...sources].map(([filePath, text]) => fileRecord(filePath, text)).sort((left, right) => left.path.localeCompare(right.path));
	const readText = async (absolutePath: string): Promise<string> => sources.get(path.relative(root, absolutePath).replaceAll(path.sep, "/")) ?? "";
	const indexed = await indexRepoMapSymbols({ root, files, concurrency: 2, readText });
	const mapId = "a".repeat(64);
	const architecture = await buildRepoMapArchitecture({ root, mapId, files, symbols: indexed.symbols, readText });
	const baseEdges = [...buildRepoMapRelationships({ mapId, files, symbols: architecture.symbols, imports: indexed.imports }), ...architecture.edges].sort(compareRepoMapEdge);
	const testGraph = await buildRepoMapTestGraph({ root, files, symbols: architecture.symbols, edges: baseEdges, readText });
	const edges = [...baseEdges, ...testGraph.edges].sort(compareRepoMapEdge);
	const metadata: RepoMapMetadata = {
		schemaVersion: 5,
		mapId,
		repositoryRoot: root,
		worktreeRoot: root,
		gitCommonDir: path.join(root, ".git"),
		generation: generationCharacter.repeat(64),
		createdAt: "2026-07-18T00:00:00.000Z",
		updatedAt: "2026-07-18T00:00:00.000Z",
		freshness: "fresh",
		fileCount: files.length,
		indexedFileCount: files.length,
		parsedFileCount: indexed.parsedFileCount,
		unsupportedFileCount: indexed.unsupportedFileCount,
		parseErrorFileCount: indexed.parseErrorFileCount,
		symbolCount: architecture.symbols.length,
		testNodeCount: testGraph.nodes.length,
		edgeCount: edges.length,
		aliasCount: 0,
		tooLargeFileCount: 0,
		diagnosticCount: architecture.diagnostics.length + testGraph.diagnostics.length,
		configFingerprint: "config",
		ignoreFingerprint: "ignore",
		parserFingerprint: "parser",
	};
	return { metadata, files, symbols: architecture.symbols, tests: testGraph.nodes, architecture: architecture.nodes, aliases: [], edges, diagnostics: [...architecture.diagnostics, ...testGraph.diagnostics] };
}

async function writeSources(root: string, sources: ReadonlyMap<string, string>): Promise<void> {
	for (const [filePath, source] of sources) {
		await mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
		await writeFile(path.join(root, filePath), source);
	}
}

function fileRecord(filePath: string, text: string): RepoMapFileRecord {
	return { id: `file:${filePath}`, path: filePath, size: Buffer.byteLength(text), mtimeMs: 1, status: "indexed", contentHash: createHash("sha256").update(text).digest("hex") };
}

function activationEntry(generation: RepoMapGeneration): SessionEntry {
	return {
		type: "custom",
		id: `activation-${generation.metadata.generation[0]}`,
		parentId: null,
		timestamp: "t",
		customType: REPO_MAP_SESSION_ENTRY,
		data: {
			kind: "activation",
			root: generation.metadata.repositoryRoot,
			mapId: generation.metadata.mapId,
			generation: generation.metadata.generation,
			activatedAt: generation.metadata.updatedAt,
		},
	};
}

function initializeResult(generation: RepoMapGeneration): InitializeRepoMapResult {
	return {
		identity: { repositoryRoot: generation.metadata.repositoryRoot, worktreeRoot: generation.metadata.worktreeRoot, gitCommonDir: generation.metadata.gitCommonDir },
		metadata: generation.metadata,
		summary: {
			discovered: generation.files.length,
			indexed: generation.files.length,
			reused: 0,
			hashed: generation.files.length,
			added: 0,
			changed: 1,
			removed: 0,
			tooLarge: 0,
			unreadable: 0,
			unstable: 0,
			parsed: generation.metadata.parsedFileCount,
			unsupported: generation.metadata.unsupportedFileCount,
			parseErrors: 0,
			reusedParsed: 0,
			symbols: generation.symbols.length,
			testNodes: generation.tests.length,
			edges: generation.edges.length,
			skippedDirectories: 0,
			diagnostics: generation.diagnostics.length,
		},
		reusedGeneration: false,
	};
}

function serviceDependencies(root: string): Partial<RepoMapServiceDependencies> {
	return {
		async detectRepository() { return { repositoryRoot: root, worktreeRoot: root, gitCommonDir: path.join(root, ".git"), headRevision: "a".repeat(40) }; },
		async readHeadRevision() { return "a".repeat(40); },
		async loadRepoMapConfig() { return defaultRepoMapConfig(); },
		async loadFileToolsConfig() { return defaultFileToolsConfig(); },
		async createIgnoreSnapshot(scanRoot, config) { defaultIgnoreEngine.invalidate(); return await createIgnoreSnapshot(scanRoot, config); },
		cacheRoot: () => path.join(temp.path, "cache"),
		now: () => new Date("2026-07-18T00:00:00.000Z"),
	};
}

async function persistedGeneration(root: string, mapId: string, generation: string): Promise<RepoMapGeneration> {
	const value = await readActivatedRepoMap({ root, mapId, generation }, path.join(temp.path, "cache"));
	if (value === undefined) throw new Error("missing persisted generation");
	return value;
}
