import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { javascriptSyntaxFacts } from "../../src/repo-map/indexing/syntax-facts.js";
import { buildRepoMapTestGraph } from "../../src/repo-map/indexing/test-indexer.js";
import { createRepoMapFileToolQuery } from "../../src/repo-map/query/file-tool-query.js";
import { RepoMapQueryIndex } from "../../src/repo-map/query/query.js";
import { initializeRepoMap } from "../../src/repo-map/runtime/service.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";
import { activationEntry, configureFileTools, readGeneration, serviceDependencies, writeSources } from "./fixtures.js";
import { generationWithTestGraph, testGraphBuildInput, testGraphSources } from "./test-graph-fixtures.js";
import type { RepoMapGeneration } from "../../src/repo-map/storage/storage.js";

const temp = useTempDir("o-pi-repo-test-graph-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(async () => {
	await configureFileTools(temp.path, { read_lines: 40, read_bytes: 16_384, find_result_limit: 30, grep_result_limit: 30 });
});

describe("Repo Map test graph", () => {
	it("indexes named tests, imports, mocks, fixtures, snapshots, and runner configuration with evidence", async () => {
		const generation = await generationWithTestGraph(temp.path, testGraphSources("export function loadUser() { return 'user'; }\n"), "1");
		expect(generation.tests).toEqual(expect.arrayContaining([
			expect.objectContaining({ testKind: "file", name: "tests/user.test.ts", source: "convention" }),
			expect.objectContaining({ testKind: "symbol", name: "loadUser returns a user", source: "syntax" }),
			expect.objectContaining({ testKind: "symbol", name: "table-driven user", source: "syntax" }),
		]));
		expect(generation.tests.some((node) => node.name === "not a real test")).toBe(false);
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

	it("reuses the whole test graph for a production body change without reading or parsing tests", async () => {
		const root = path.join(temp.path, "reuse");
		const previousSources = testGraphSources("export function loadUser() { return 'user'; }\n");
		const previous = await generationWithTestGraph(root, previousSources, "4");
		const currentSources = new Map(previousSources);
		currentSources.set("src/user.ts", "export function loadUser() { return 'next'; }\n");
		const current = await testGraphBuildInput(root, currentSources);
		const readText = vi.fn(async () => { throw new Error("unexpected test graph read"); });
		const parseJavaScriptFacts = vi.fn(javascriptSyntaxFacts);

		const result = await buildRepoMapTestGraph({
			...current,
			readText,
			parseJavaScriptFacts,
			previous: previousTestGraph(previous),
		});

		expect(readText).not.toHaveBeenCalled();
		expect(parseJavaScriptFacts).not.toHaveBeenCalled();
		expect(result).toEqual({ nodes: previous.tests, edges: testOwnedEdges(previous), diagnostics: [] });
	});

	it("passes the previous test graph through the refresh service", async () => {
		const root = path.join(temp.path, "service-reuse");
		const cacheRoot = path.join(temp.path, "service-cache");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeSources(root, testGraphSources("export function loadUser() { return 'user'; }\n"));
		await initializeRepoMap({ cwd: root }, serviceDependencies(root, cacheRoot));
		await writeFile(path.join(root, "src", "user.ts"), "export function loadUser() { return 'next'; }\n");
		const readText = vi.fn(async () => { throw new Error("unexpected test graph read"); });
		const parseJavaScriptFacts = vi.fn(javascriptSyntaxFacts);
		const buildTestGraph = vi.fn(async (input: Parameters<typeof buildRepoMapTestGraph>[0]) =>
			await buildRepoMapTestGraph({ ...input, readText, parseJavaScriptFacts }));

		const refreshed = await initializeRepoMap({ cwd: root, mode: "refresh" }, {
			...serviceDependencies(root, cacheRoot),
			buildTestGraph,
		});

		expect(refreshed.metadata.testNodeCount).toBeGreaterThan(0);
		expect(buildTestGraph).toHaveBeenCalledOnce();
		expect(buildTestGraph.mock.calls[0]?.[0].previous?.tests.length).toBeGreaterThan(0);
		expect(readText).not.toHaveBeenCalled();
		expect(parseJavaScriptFacts).not.toHaveBeenCalled();
	});

	it.each([
		["test source", (sources: Map<string, string>) => sources.set("tests/user.test.ts", `${sources.get("tests/user.test.ts")}\ntest('added case', () => true);\n`)],
		["test import target", (sources: Map<string, string>) => sources.set("tests/user.test.ts", sources.get("tests/user.test.ts")?.replace("import { loadUser } from '../src/user';", "import { loadUser } from '../src/neighbor';") ?? "")],
		["symbol name", (sources: Map<string, string>) => sources.set("src/user.ts", "export function fetchUser() { return 'user'; }\n")],
		["runner config", (sources: Map<string, string>) => sources.set("vitest.config.ts", `${sources.get("vitest.config.ts")}\n// changed\n`)],
		["mock resource", (sources: Map<string, string>) => sources.set("tests/__mocks__/user.ts", "export const mocked = 2;\n")],
		["fixture resource", (sources: Map<string, string>) => sources.set("tests/fixtures/user.json", "{\"name\":\"changed\"}\n")],
		["snapshot resource", (sources: Map<string, string>) => sources.set("tests/__snapshots__/user.test.ts.snap", "exports[`changed 1`] = `next`;\n")],
		["file addition", (sources: Map<string, string>) => sources.set("src/added.ts", "export const added = true;\n")],
		["file removal", (sources: Map<string, string>) => sources.delete("src/neighbor.ts")],
	] as const)("rebuilds an oracle-equivalent test graph after %s changes", async (_name, mutate) => {
		const root = path.join(temp.path, "invalidation");
		const previousSources = testGraphSources("export function loadUser() { return 'user'; }\n");
		previousSources.set("tests/__mocks__/user.ts", "export const mocked = 1;\n");
		const previous = await generationWithTestGraph(root, previousSources, "5");
		const currentSources = new Map(previousSources);
		mutate(currentSources);
		const current = await testGraphBuildInput(root, currentSources);
		const readText = vi.fn(current.readText);
		const parseJavaScriptFacts = vi.fn(javascriptSyntaxFacts);

		const incremental = await buildRepoMapTestGraph({
			...current,
			readText,
			parseJavaScriptFacts,
			previous: previousTestGraph(previous),
		});
		const rebuilt = await buildRepoMapTestGraph(current);

		expect(readText).toHaveBeenCalled();
		expect(parseJavaScriptFacts).toHaveBeenCalled();
		expect(incremental).toEqual(rebuilt);
	});

	it("invalidates reuse when a test import relation changes independently of file content", async () => {
		const root = path.join(temp.path, "import-relation");
		const sources = testGraphSources("export function loadUser() { return 'user'; }\n");
		const previous = await generationWithTestGraph(root, sources, "7");
		const current = await testGraphBuildInput(root, sources);
		const edges = current.edges.map((edge) => edge.kind === "imports"
			&& edge.from === "file:tests/user.test.ts"
			&& edge.lexicalTarget === "../src/user"
			? { ...edge, to: "file:src/neighbor.ts" }
			: edge);
		const readText = vi.fn(current.readText);
		const parseJavaScriptFacts = vi.fn(javascriptSyntaxFacts);

		const incremental = await buildRepoMapTestGraph({
			...current,
			edges,
			readText,
			parseJavaScriptFacts,
			previous: previousTestGraph(previous),
		});
		const rebuilt = await buildRepoMapTestGraph({ ...current, edges });

		expect(readText).toHaveBeenCalled();
		expect(parseJavaScriptFacts).toHaveBeenCalled();
		expect(incremental).toEqual(rebuilt);
		expect(incremental.edges).toContainEqual(expect.objectContaining({ kind: "tests", to: "file:src/neighbor.ts" }));
	});

	it("retries a previous transient test graph diagnostic", async () => {
		const root = path.join(temp.path, "diagnostic-retry");
		const sources = testGraphSources("export function loadUser() { return 'user'; }\n");
		const previous = await generationWithTestGraph(root, sources, "6");
		const current = await testGraphBuildInput(root, sources);
		const readText = vi.fn(current.readText);
		const parseJavaScriptFacts = vi.fn(javascriptSyntaxFacts);

		const result = await buildRepoMapTestGraph({
			...current,
			readText,
			parseJavaScriptFacts,
			previous: {
				...previousTestGraph(previous),
				diagnostics: [{ code: "TEST_GRAPH_FILE_UNREADABLE", message: "transient", path: "tests/user.test.ts" }],
			},
		});

		expect(readText).toHaveBeenCalled();
		expect(parseJavaScriptFacts).toHaveBeenCalled();
		expect(result.diagnostics).toEqual([]);
	});

	it("persists test nodes in generation hash and removes deleted test resources without dangling edges", async () => {
		const root = path.join(temp.path, "incremental");
		const cacheRoot = path.join(temp.path, "cache");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeSources(root, testGraphSources("export function loadUser() { return 'user'; }\n"));
		const first = await initializeRepoMap({ cwd: root }, serviceDependencies(root, cacheRoot));
		const initial = await readGeneration(root, cacheRoot, first.metadata.mapId, first.metadata.generation);
		expect(initial.metadata.testNodeCount).toBe(initial.tests.length);
		expect(initial.tests.length).toBeGreaterThan(1);
		const testsSnapshot = JSON.parse(await readFile(path.join(cacheRoot, first.metadata.mapId, "generations", first.metadata.generation, "tests.json"), "utf8")) as unknown[];
		expect(testsSnapshot.length).toBe(initial.tests.length);

		await rm(path.join(root, "tests"), { recursive: true });
		const refreshed = await initializeRepoMap({ cwd: root, mode: "refresh" }, serviceDependencies(root, cacheRoot));
		const current = await readGeneration(root, cacheRoot, refreshed.metadata.mapId, refreshed.metadata.generation);
		expect(refreshed.metadata.generation).not.toBe(first.metadata.generation);
		expect(current.tests).toEqual([]);
		expect(JSON.stringify(current)).not.toContain("tests/user.test.ts");
		const ids = new Set([`repository:${current.metadata.mapId}`, ...current.files.map((file) => file.id), ...current.symbols.map((symbol) => symbol.id), ...current.tests.map((node) => node.id), ...current.architecture.map((node) => node.id)]);
		expect(current.edges.every((edge) => ids.has(edge.from) && (ids.has(edge.to) || edge.to.startsWith("external:") || edge.to.startsWith("lexical:")))).toBe(true);
	});

	it("drops related test candidates when their live hash no longer matches", async () => {
		const sources = testGraphSources("export function loadUser() { return 'user'; }\n");
		await writeSources(temp.path, sources);
		const generation = await generationWithTestGraph(temp.path, sources, "3");
		const active = createRepoMapFileToolQuery(() => [activationEntry(generation.metadata)], { readActivated: async () => generation });
		const userHash = generation.files.find((file) => file.path === "src/user.ts")?.contentHash;
		if (userHash === undefined) throw new Error("missing user hash");
		const readContext = await active.readContext({ requestedPath: path.join(temp.path, "src", "user.ts"), contentHash: userHash, startLine: 1, endLine: 1, partial: true, truncated: false });
		expect(readContext?.suggestedTests).toContain("tests/user.test.ts");
		const fresh = await active.query({ requestedPath: temp.path, query: "loadUser", limit: 30 });
		expect(fresh?.candidates.map((candidate) => candidate.path)).toContain("tests/user.test.ts");
		await writeFile(path.join(temp.path, "tests", "user.test.ts"), "test('changed', () => true);\n");
		const staleReadContext = await active.readContext({ requestedPath: path.join(temp.path, "src", "user.ts"), contentHash: userHash, startLine: 1, endLine: 1, partial: true, truncated: false });
		expect(staleReadContext?.suggestedTests).not.toContain("tests/user.test.ts");
		const stale = await active.query({ requestedPath: temp.path, query: "loadUser", limit: 30 });
		expect(stale?.candidates.map((candidate) => candidate.path)).not.toContain("tests/user.test.ts");
	});
});

function previousTestGraph(generation: RepoMapGeneration) {
	return {
		files: generation.files,
		symbols: generation.symbols,
		tests: generation.tests,
		edges: generation.edges,
		diagnostics: generation.diagnostics,
	};
}

function testOwnedEdges(generation: RepoMapGeneration) {
	const testIds = new Set(generation.tests.map((node) => node.id));
	return generation.edges.filter((edge) => testIds.has(edge.from) || testIds.has(edge.to));
}
