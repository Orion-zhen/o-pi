import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { findWorkspaceFiles } from "../../src/file-tools/tools/find.js";
import { grepWorkspaceFiles } from "../../src/file-tools/tools/grep.js";
import { buildRepoMapArchitecture } from "../../src/repo-map/architecture-indexer.js";
import { createRepoMapFileToolQuery } from "../../src/repo-map/file-tool-query.js";
import { buildRepoMapLexicalAliases } from "../../src/repo-map/lexical-indexer.js";
import { RepoMapQueryIndex } from "../../src/repo-map/query.js";
import { buildRepoMapRelationships } from "../../src/repo-map/relationship-indexer.js";
import { initializeRepoMap } from "../../src/repo-map/service.js";
import type { RepoMapGeneration } from "../../src/repo-map/storage.js";
import { indexRepoMapSymbols } from "../../src/repo-map/symbol-indexer.js";
import type { RepoMapEdge, RepoMapFileRecord, RepoMapMetadata, RepoMapSymbolNode } from "../../src/repo-map/types.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";
import { activationEntry, configureFileTools, fileRecord, readGeneration, serviceDependencies, writeSources } from "./fixtures.js";

const temp = useTempDir("o-pi-repo-lexical-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(async () => {
	await configureFileTools(temp.path, { read_lines: 20, read_bytes: 8192, find_result_limit: 20, grep_result_limit: 20 });
});

describe("Repo Map lexical projection", () => {
	it("derives traceable camel/snake, import alias, registration, config, environment, and doc aliases", async () => {
		const sources = new Map([
			["package.json", JSON.stringify({ name: "repo-tools", main: "./src/repositoryClient.ts" })],
			["src/transport.ts", "export function createTransport() { return true; }\nexport function secondTransport() { return false; }\n"],
			["src/repositoryClient.ts", [
				"/** Diagnostics routing for repository clients. */",
				"import { createTransport as buildTransport, secondTransport as fallbackTransport } from './transport';",
				"export const cache_directory = { 'retry-limit': 3 };",
				"export const env = process.env.REPO_CACHE_DIR;",
				"export function loadRepoConfig() { return buildTransport(); }",
			].join("\n")],
			["agent/extensions/tools.ts", "export default function tools(pi: any) { pi.registerCommand('serve-repo', {}); pi.registerTool({ name: 'inspect-cfg', execute() {} }); }\n"],
		]);
		const generation = await generationFromSources(temp.path, sources);

		expect(generation.aliases).toEqual(expect.arrayContaining([
			expect.objectContaining({ term: "repository client", source: "file-path", target: "file:src/repositoryClient.ts" }),
			expect.objectContaining({ term: "cache directory", source: "symbol" }),
			expect.objectContaining({ term: "build transport", source: "import-alias" }),
			expect.objectContaining({ term: "fallback transport", source: "import-alias" }),
			expect.objectContaining({ term: "retry limit", source: "config-key" }),
			expect.objectContaining({ term: "repo cache dir", canonical: "repository cache dir", source: "environment" }),
			expect.objectContaining({ term: "diagnostics", source: "doc-comment" }),
			expect.objectContaining({ term: "serve repo", canonical: "serve repository", source: "registration" }),
		]));
		expect(generation.aliases.every((alias) => alias.evidence.length > 0 && alias.evidence.every((evidence) => evidence.path.length > 0))).toBe(true);

		const index = new RepoMapQueryIndex(generation);
		expect(index.candidates("repository client").candidates).toContainEqual(expect.objectContaining({ path: "src/repositoryClient.ts", hop: 0, reasons: expect.arrayContaining(["alias"]) }));
		expect(index.candidates("build_transport").candidates.map((candidate) => candidate.path)).toContain("src/repositoryClient.ts");
		expect(index.candidates("cmd").explanation.expandedTerms).toContain("command");
		expect(index.candidates("cmd").candidates.map((candidate) => candidate.path)).toContain("agent/extensions/tools.ts");
		expect(index.candidates("inspect cfg").candidates.map((candidate) => candidate.path)).toContain("agent/extensions/tools.ts");
	});

	it("walks at most two hops, stops low-confidence lexical propagation, and suppresses hub fan-out", () => {
		const generation = graphGeneration();
		const candidates = new RepoMapQueryIndex(generation).candidates("alpha", 100).candidates;
		expect(candidates).toContainEqual(expect.objectContaining({ path: "b.ts", hop: 1, reasons: expect.arrayContaining(["callee"]) }));
		expect(candidates).toContainEqual(expect.objectContaining({ path: "c.ts", hop: 2 }));
		expect(candidates.find((candidate) => candidate.path === "d.ts")).toBeUndefined();
		expect(candidates).toContainEqual(expect.objectContaining({ path: "low.ts", hop: 1 }));
		expect(candidates.map((candidate) => candidate.path)).not.toContain("far.ts");
		const hubResults = candidates.filter((candidate) => candidate.hop === 2 && candidate.path.startsWith("hub/"));
		expect(hubResults.length).toBeGreaterThan(0);
		expect(hubResults.length).toBeLessThanOrEqual(5);
		expect(candidates.every((candidate) => candidate.hop <= 2 && candidate.relatedEdges.every((edge) => edge.hop <= 2 && edge.evidence.length > 0))).toBe(true);
	});

	it("packs different relation roles and components within a tight budget", () => {
		const generation = graphGeneration();
		const candidates = new RepoMapQueryIndex(generation).candidates("alpha", 5).candidates;
		const roles = new Set(candidates.flatMap((candidate) => candidate.reasons));
		expect(roles.has("callee")).toBe(true);
		expect(roles.has("import")).toBe(true);
		const paths = candidates.map((candidate) => candidate.path);
		expect(paths.some((candidatePath) => candidatePath.startsWith("component-b/"))).toBe(true);
	});

	it("keeps literal/regex recall unchanged and applies alias candidates only while active and live", async () => {
		const sources = new Map([
			["src/repositoryClient.ts", "export function repositoryClient() { return 'literal-needle'; }\n"],
			["src/unrelated.ts", "export const other = 'literal-needle';\n"],
		]);
		await writeSources(temp.path, sources);
		const generation = await generationFromSources(temp.path, sources);
		const readActivated = vi.fn(async () => generation);
		const inactive = createRepoMapFileToolQuery(() => [], { readActivated });
		const baseline = await findWorkspaceFiles(temp.path, { query: "repo client" });
		expect(await findWorkspaceFiles(temp.path, { query: "repo client" }, undefined, { repoMap: inactive })).toEqual(baseline);
		expect(readActivated).not.toHaveBeenCalled();

		const active = createRepoMapFileToolQuery(() => [activationEntry(generation.metadata)], { readActivated });
		const found = await findWorkspaceFiles(temp.path, { query: "repo client" }, undefined, { repoMap: active });
		expect("status" in found ? [] : found.details.matches).toContainEqual({ path: "src/repositoryClient.ts", kind: "file" });
		for (const match of ["literal", "regex"] as const) {
			const plain = await grepWorkspaceFiles(temp.path, { query: match === "literal" ? "literal-needle" : "literal-(?:needle)", match });
			const enhanced = await grepWorkspaceFiles(temp.path, { query: match === "literal" ? "literal-needle" : "literal-(?:needle)", match }, undefined, { repoMap: active });
			if (plain.status === "failed" || enhanced.status === "failed") throw new Error("grep failed");
			expect(enhanced.regions.map((region) => region.path)).toEqual(plain.regions.map((region) => region.path));
		}

		await writeFile(path.join(temp.path, "src/repositoryClient.ts"), "export const changed = true;\n");
		const changed = await active.query({ requestedPath: temp.path, query: "repo client", limit: 20 });
		expect(changed?.candidates.map((candidate) => candidate.path)).not.toContain("src/repositoryClient.ts");
	});

	it("persists stable aliases and removes changed/deleted targets on incremental refresh", async () => {
		const root = path.join(temp.path, "incremental");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await mkdir(path.join(root, "src"), { recursive: true });
		await writeFile(path.join(root, "src/legacy-client.ts"), "export function legacyClient() {}\n");
		const first = await initializeRepoMap({ cwd: root }, serviceDependencies(root, path.join(temp.path, "cache")));
		const firstGeneration = await readGeneration(root, path.join(temp.path, "cache"), first.metadata.mapId, first.metadata.generation);
		expect(firstGeneration.aliases.some((alias) => alias.term === "legacy client")).toBe(true);

		const stable = await initializeRepoMap({ cwd: root, mode: "refresh" }, serviceDependencies(root, path.join(temp.path, "cache")));
		expect(stable.metadata.generation).toBe(first.metadata.generation);
		await writeFile(path.join(root, "src/modern-client.ts"), "export function modernClient() {}\n");
		await rm(path.join(root, "src/legacy-client.ts"));
		const refreshed = await initializeRepoMap({ cwd: root, mode: "refresh" }, serviceDependencies(root, path.join(temp.path, "cache")));
		const current = await readGeneration(root, path.join(temp.path, "cache"), refreshed.metadata.mapId, refreshed.metadata.generation);
		expect(current.aliases.some((alias) => alias.term === "modern client")).toBe(true);
		expect(current.aliases.some((alias) => alias.term === "legacy client" || alias.target.includes("legacy-client"))).toBe(false);
		expect(current.metadata.aliasCount).toBe(current.aliases.length);
	});

	it("reads only changed sources while matching a full lexical rebuild", async () => {
		const root = path.join(temp.path, "incremental-lexical");
		const sources = new Map([
			["src/changed.ts", "/** old client */\nexport const OLD_CLIENT_ENV = true;\n"],
			["src/stable.ts", "/** stable transport */\nexport const STABLE_TRANSPORT_ENV = true;\n"],
		]);
		const read = async (absolutePath: string): Promise<string> => sources.get(path.relative(root, absolutePath).replaceAll(path.sep, "/")) ?? "";
		const previousFiles = [...sources].map(([filePath, text]) => fileRecord(filePath, text));
		const previousAliases = await buildRepoMapLexicalAliases({ root, files: previousFiles, symbols: [], architecture: [], edges: [], concurrency: 2, readText: read });

		sources.set("src/changed.ts", "/** modern client */\nexport const MODERN_CLIENT_ENV = true;\n");
		const files = [...sources].map(([filePath, text]) => fileRecord(filePath, text));
		const incrementalRead = vi.fn(read);
		const incremental = await buildRepoMapLexicalAliases({
			root,
			files,
			symbols: [],
			architecture: [],
			edges: [],
			concurrency: 2,
			previous: { files: previousFiles, aliases: previousAliases },
			readText: incrementalRead,
		});
		const rebuilt = await buildRepoMapLexicalAliases({ root, files, symbols: [], architecture: [], edges: [], concurrency: 2, readText: read });

		expect(incremental).toEqual(rebuilt);
		expect(incrementalRead).toHaveBeenCalledTimes(1);
		expect(path.relative(root, incrementalRead.mock.calls[0]?.[0] ?? "").replaceAll(path.sep, "/")).toBe("src/changed.ts");
	});
});

async function generationFromSources(root: string, sources: ReadonlyMap<string, string>): Promise<RepoMapGeneration> {
	const files = [...sources].map(([filePath, text]) => fileRecord(filePath, text)).sort((left, right) => left.path.localeCompare(right.path));
	const readText = async (absolutePath: string): Promise<string> => sources.get(path.relative(root, absolutePath).replaceAll(path.sep, "/")) ?? "";
	const indexed = await indexRepoMapSymbols({ root, files, concurrency: 2, readText });
	const mapId = "a".repeat(64);
	const architecture = await buildRepoMapArchitecture({ root, mapId, files, symbols: indexed.symbols, readText });
	const edges = [...buildRepoMapRelationships({ mapId, files, symbols: architecture.symbols, imports: indexed.imports }), ...architecture.edges];
	const aliases = await buildRepoMapLexicalAliases({ root, files, symbols: architecture.symbols, architecture: architecture.nodes, edges, concurrency: 2, readText });
	const metadata: RepoMapMetadata = {
		schemaVersion: 5, mapId, repositoryRoot: root, worktreeRoot: root, gitCommonDir: path.join(root, ".git"), generation: "b".repeat(64),
		createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z", freshness: "fresh",
		fileCount: files.length, indexedFileCount: files.length, parsedFileCount: indexed.parsedFileCount, unsupportedFileCount: indexed.unsupportedFileCount,
		parseErrorFileCount: indexed.parseErrorFileCount, symbolCount: architecture.symbols.length, testNodeCount: 0, edgeCount: edges.length, aliasCount: aliases.length,
		tooLargeFileCount: 0, diagnosticCount: architecture.diagnostics.length, configFingerprint: "config", ignoreFingerprint: "ignore", parserFingerprint: "parser",
	};
	return { metadata, files, symbols: architecture.symbols, tests: [], architecture: architecture.nodes, aliases, edges, diagnostics: architecture.diagnostics };
}

function graphGeneration(): RepoMapGeneration {
	const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "low.ts", "far.ts", "component-b/imported.ts", ...Array.from({ length: 12 }, (_, index) => `hub/${index}.ts`)];
	const files = paths.map((filePath) => fileRecord(filePath, filePath));
	const symbols = files.map((file, index) => symbol(file, index === 0 ? "alpha" : `node${index}`));
	const byPath = new Map(files.map((file, index) => [file.path, symbols[index]]));
	const alpha = required(byPath, "a.ts");
	const beta = required(byPath, "b.ts");
	const gamma = required(byPath, "c.ts");
	const delta = required(byPath, "d.ts");
	const low = required(byPath, "low.ts");
	const far = required(byPath, "far.ts");
	const importedFile = files.find((file) => file.path === "component-b/imported.ts");
	if (importedFile === undefined) throw new Error("missing imported file");
	const edges: RepoMapEdge[] = [
		edge(alpha.id, beta.id, "calls", 0.95, "syntactic", "a.ts"),
		edge(beta.id, gamma.id, "calls", 0.95, "syntactic", "b.ts"),
		edge(gamma.id, delta.id, "calls", 0.95, "syntactic", "c.ts"),
		edge(alpha.id, low.id, "references", 0.5, "lexical", "a.ts"),
		edge(low.id, far.id, "calls", 0.95, "syntactic", "low.ts"),
		edge(alpha.fileId, importedFile.id, "imports", 0.92, "syntactic", "a.ts"),
		...Array.from({ length: 12 }, (_, index) => edge(beta.id, required(byPath, `hub/${index}.ts`).id, "references", 0.9, "syntactic", "b.ts")),
	];
	const architecture = [
		{ kind: "package" as const, id: "package:root", name: "root", rootPath: ".", ecosystem: "repository" as const, source: "convention" as const, confidence: 1 },
		{ kind: "component" as const, id: "component:a", name: "a", rootPath: ".", packageId: "package:root", source: "convention" as const, confidence: 0.8 },
		{ kind: "component" as const, id: "component:b", name: "b", rootPath: "component-b", packageId: "package:root", source: "convention" as const, confidence: 0.8 },
	];
	for (const file of files) edges.push(edge(file.id, file.path.startsWith("component-b/") ? "component:b" : "component:a", "belongs-to", 0.9, "syntactic", file.path));
	const metadata: RepoMapMetadata = {
		schemaVersion: 5, mapId: "a".repeat(64), repositoryRoot: temp.path, worktreeRoot: temp.path, gitCommonDir: path.join(temp.path, ".git"), generation: "b".repeat(64),
		createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z", freshness: "fresh",
		fileCount: files.length, indexedFileCount: files.length, parsedFileCount: files.length, unsupportedFileCount: 0, parseErrorFileCount: 0,
		symbolCount: symbols.length, testNodeCount: 0, edgeCount: edges.length, aliasCount: 0, tooLargeFileCount: 0, diagnosticCount: 0,
		configFingerprint: "config", ignoreFingerprint: "ignore", parserFingerprint: "parser",
	};
	return { metadata, files, symbols, tests: [], architecture, aliases: [], edges, diagnostics: [] };
}

function edge(from: string, to: string, kind: RepoMapEdge["kind"], confidence: number, resolution: RepoMapEdge["resolution"], evidencePath: string): RepoMapEdge {
	return { from, to, kind, confidence, resolution, source: "tree-sitter", evidence: [{ path: evidencePath, startLine: 1, endLine: 1, startByte: 0, endByte: 1 }] };
}

function symbol(file: RepoMapFileRecord, name: string): RepoMapSymbolNode {
	return { kind: "symbol", id: `symbol:${name}`, fileId: file.id, symbolKind: "function", name, qualifiedName: name, signature: `function ${name}()`, startLine: 1, endLine: 1, startByte: 0, endByte: 1, definitions: [name], references: [], calls: [], imports: [] };
}

function required(values: ReadonlyMap<string, RepoMapSymbolNode | undefined>, key: string): RepoMapSymbolNode {
	const value = values.get(key);
	if (value === undefined) throw new Error(`missing ${key}`);
	return value;
}
