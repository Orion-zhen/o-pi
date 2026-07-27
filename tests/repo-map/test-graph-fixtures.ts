import path from "node:path";

import { buildRepoMapArchitecture } from "../../src/repo-map/indexing/architecture-indexer.js";
import { compareRepoMapEdge } from "../../src/repo-map/core/graph.js";
import { buildRepoMapRelationships } from "../../src/repo-map/indexing/relationship-indexer.js";
import type { InitializeRepoMapResult } from "../../src/repo-map/runtime/service.js";
import type { RepoMapGeneration } from "../../src/repo-map/storage/storage.js";
import { indexRepoMapSymbols } from "../../src/repo-map/indexing/symbol-indexer.js";
import { buildRepoMapTestGraph } from "../../src/repo-map/indexing/test-indexer.js";
import type { RepoMapMetadata } from "../../src/repo-map/core/types.js";
import { fileRecord } from "./fixtures.js";

export function testGraphSources(userSource: string): Map<string, string> {
	return new Map([
		["package.json", JSON.stringify({ name: "test-graph-fixture", exports: "./src/user.ts", scripts: { test: "vitest --run" } })],
		["vitest.config.ts", "export default { test: { include: ['tests/**/*.test.ts'] } };\n"],
		["src/user.ts", userSource],
		["src/caller.ts", "import { loadUser } from './user';\nexport function renderUser() { return loadUser(); }\n"],
		["src/neighbor.ts", "export function neighbor() { return true; }\n"],
		["tests/user.test.ts", [
			"// test('not a real test', () => {});",
			"import { loadUser } from '../src/user';",
			"import fixture from './fixtures/user.json';",
			"vi.mock('../src/user');",
			"describe('user service', () => {",
			"  test('loadUser returns a user', () => { expect(loadUser()).toMatchSnapshot('user snapshot'); });",
			"  test.each([1])(`table-driven user`, () => { expect(loadUser()).toBeTruthy(); });",
			"});",
			"void fixture;",
		].join("\n")],
		["tests/fixtures/user.json", "{\"name\":\"fixture\"}\n"],
		["tests/__snapshots__/user.test.ts.snap", "exports[`user snapshot 1`] = `user`;\n"],
	]);
}

export async function testGraphBuildInput(root: string, sources: ReadonlyMap<string, string>) {
	const files = [...sources]
		.map(([filePath, text]) => fileRecord(filePath, text))
		.sort((left, right) => left.path.localeCompare(right.path));
	const readText = async (absolutePath: string): Promise<string> => sources.get(path.relative(root, absolutePath).replaceAll(path.sep, "/")) ?? "";
	const indexed = await indexRepoMapSymbols({ root, files, concurrency: 2, readText });
	const mapId = "a".repeat(64);
	const architecture = await buildRepoMapArchitecture({ root, mapId, files, symbols: indexed.symbols, readText });
	const edges = [
		...buildRepoMapRelationships({ mapId, files, symbols: architecture.symbols, imports: indexed.imports }),
		...architecture.edges,
	].sort(compareRepoMapEdge);
	return { root, files, symbols: architecture.symbols, edges, readText, indexed, architecture };
}

export async function generationWithTestGraph(
	root: string,
	sources: ReadonlyMap<string, string>,
	generationCharacter: string,
): Promise<RepoMapGeneration> {
	const input = await testGraphBuildInput(root, sources);
	const { files, symbols, edges: baseEdges, indexed, architecture } = input;
	const testGraph = await buildRepoMapTestGraph(input);
	const mapId = "a".repeat(64);
	const edges = [...baseEdges, ...testGraph.edges].sort(compareRepoMapEdge);
	const metadata: RepoMapMetadata = {
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
		symbolCount: symbols.length,
		testNodeCount: testGraph.nodes.length,
		edgeCount: edges.length,
		aliasCount: 0,
		tooLargeFileCount: 0,
		diagnosticCount: architecture.diagnostics.length + testGraph.diagnostics.length,
		configFingerprint: "config",
		ignoreFingerprint: "ignore",
	};
	return {
		metadata,
		files,
		symbols,
		tests: testGraph.nodes,
		architecture: architecture.nodes,
		aliases: [],
		edges,
		diagnostics: [...architecture.diagnostics, ...testGraph.diagnostics],
	};
}

export function initializeResult(generation: RepoMapGeneration): InitializeRepoMapResult {
	return {
		identity: {
			repositoryRoot: generation.metadata.repositoryRoot,
			worktreeRoot: generation.metadata.worktreeRoot,
			gitCommonDir: generation.metadata.gitCommonDir,
		},
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
