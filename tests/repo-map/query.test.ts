import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearGrepIndex } from "../../src/file-tools/grep/indexer.js";
import { findWorkspaceFiles } from "../../src/file-tools/tools/find.js";
import { formatCompactGrepResult, grepWorkspaceFiles } from "../../src/file-tools/tools/grep.js";
import { createRepoMapFileToolQuery } from "../../src/repo-map/file-tool-query.js";
import { buildRepoMapRelationships } from "../../src/repo-map/relationship-indexer.js";
import { RepoMapQueryIndex } from "../../src/repo-map/query.js";
import { indexRepoMapSymbols } from "../../src/repo-map/symbol-indexer.js";
import type { RepoMapGeneration } from "../../src/repo-map/storage.js";
import type { RepoMapMetadata } from "../../src/repo-map/types.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";
import { activationEntry, configureFileTools, fileRecord, writeSources } from "./fixtures.js";

const workspaceTemp = useTempDir("o-pi-repo-query-");
const configTemp = useTempDir("o-pi-repo-query-config-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(async () => {
	await configureFileTools(configTemp.path, { find_result_limit: 8, grep_result_limit: 8, grep_output_token_budget: 1600 });
	clearGrepIndex();
});

describe("Repo Map query and file-tool integration", () => {
	it("queries paths, qualified/short symbols, definitions, exports, and only one relation hop", async () => {
		const sources = new Map([
			["src/a.ts", "import { second, Value } from './b';\nexport class Auth { login() { return second(); } }\nexport function first() { second(); return Value; }\n"],
			["src/b.ts", "export const Value = 1;\nexport function second() { return third(); }\n"],
			["src/c.ts", "export function third() { return 3; }\n"],
		]);
		const generation = await generationFromSources(workspaceTemp.path, sources);
		const index = new RepoMapQueryIndex(generation);

		expect(index.findFiles("b.ts")[0]).toMatchObject({ path: "src/b.ts", reasons: ["exact filename"] });
		expect(index.findSymbols("Auth.login")[0]).toMatchObject({
			path: "src/a.ts",
			symbol: { qualifiedName: "Auth.login", range: { startLine: 2, startByte: expect.any(Number), endByte: expect.any(Number) } },
		});
		expect(index.findSymbols("login")[0]).toMatchObject({ path: "src/a.ts", symbol: { name: "login" } });
		expect(index.findSymbols("function second")[0]).toMatchObject({ path: "src/b.ts", reasons: ["signature"] });
		expect(index.definitions("second")[0]?.reasons).toEqual(expect.arrayContaining(["definition", "export"]));
		expect(index.references("Value").map((candidate) => candidate.symbol?.name)).toContain("first");
		expect(index.callers("second").map((candidate) => candidate.symbol?.name)).toEqual(expect.arrayContaining(["login", "first"]));
		expect(index.callees("first").map((candidate) => candidate.symbol?.name)).toEqual(["second"]);
		expect(index.imports("second").map((candidate) => candidate.path)).toContain("src/a.ts");
		const firstCandidates = index.candidates("first").candidates;
		expect(firstCandidates.some((candidate) => candidate.symbol?.name === "second" && candidate.reasons.includes("callee"))).toBe(true);
		expect(firstCandidates.some((candidate) => candidate.symbol?.name === "third")).toBe(false);
		expect(firstCandidates.every((candidate) => candidate.score > 0 && candidate.confidence > 0)).toBe(true);
		expect(firstCandidates.flatMap((candidate) => candidate.relatedEdges).every((edge) => edge.evidence.length > 0)).toBe(true);
	});

	it("gates disk reads by activation, generation, root and freshness and degrades read failures", async () => {
		const generation = await generationFromSources(workspaceTemp.path, new Map([["target.ts", "export const Target = 1;\n"]]));
		const readActivated = vi.fn(async () => generation);
		const inactive = createRepoMapFileToolQuery(() => [], { readActivated });
		expect(await inactive.query({ requestedPath: workspaceTemp.path, query: "Target", limit: 5 })).toBeUndefined();
		expect(readActivated).not.toHaveBeenCalled();

		const active = createRepoMapFileToolQuery(() => [activationEntry(generation.metadata)], { readActivated });
		expect(await active.query({ requestedPath: workspaceTemp.path, query: "Target", limit: 5 })).toMatchObject({ root: workspaceTemp.path });
		expect(await active.query({ requestedPath: configTemp.path, query: "Target", limit: 5 })).toBeUndefined();
		expect(await createRepoMapFileToolQuery(() => [activationEntry(generation.metadata)], { async readActivated() { return undefined; } })
			.query({ requestedPath: workspaceTemp.path, query: "Target", limit: 5 })).toBeUndefined();
		const mismatched = { ...generation, metadata: { ...generation.metadata, generation: "c".repeat(64) } };
		expect(await createRepoMapFileToolQuery(() => [activationEntry(generation.metadata)], { async readActivated() { return mismatched; } })
			.query({ requestedPath: workspaceTemp.path, query: "Target", limit: 5 })).toBeUndefined();
		const stale = { ...generation, metadata: { ...generation.metadata, freshness: "stale" as const } };
		expect(await createRepoMapFileToolQuery(() => [activationEntry(generation.metadata)], { async readActivated() { return stale; } })
			.query({ requestedPath: workspaceTemp.path, query: "Target", limit: 5 })).toBeUndefined();
		expect(await createRepoMapFileToolQuery(() => [activationEntry(generation.metadata)], { async readActivated() { throw new Error("corrupt"); } })
			.query({ requestedPath: workspaceTemp.path, query: "Target", limit: 5 })).toBeUndefined();
	});

	it("find merges a live symbol definition without changing inactive baseline or crossing scope", async () => {
		const sources = new Map([
			["odd-name.ts", "export function RemoteSymbol() { return 1; }\n"],
			["plain.ts", "export const plain = 1;\n"],
		]);
		await writeSources(workspaceTemp.path, sources);
		const generation = await generationFromSources(workspaceTemp.path, sources);
		const readActivated = vi.fn(async () => generation);
		const inactiveQuery = createRepoMapFileToolQuery(() => [], { readActivated });
		const baseline = await findWorkspaceFiles(workspaceTemp.path, { query: "RemoteSymbol" });
		const inactive = await findWorkspaceFiles(workspaceTemp.path, { query: "RemoteSymbol" }, undefined, { repoMap: inactiveQuery });
		expect(inactive).toEqual(baseline);
		expect(readActivated).not.toHaveBeenCalled();

		const activeQuery = createRepoMapFileToolQuery(() => [activationEntry(generation.metadata)], { readActivated });
		const active = await findWorkspaceFiles(workspaceTemp.path, { query: "RemoteSymbol" }, undefined, { repoMap: activeQuery });
		expect("status" in active ? [] : active.details.matches).toContainEqual({ path: "odd-name.ts", kind: "file" });
		const outside = await findWorkspaceFiles(workspaceTemp.path, { path: configTemp.path, query: "RemoteSymbol" }, undefined, { repoMap: activeQuery });
		expect("status" in outside ? [] : outside.details.matches).toEqual([]);
	});

	it("grep merges definition/caller/callee/import candidates, uses live text, and rejects stale hashes", async () => {
		const sources = new Map([
			["a.ts", "import { target } from './b';\nexport function caller() { return target(); }\n"],
			["b.ts", "export function target() { return 1; }\n"],
		]);
		await writeSources(workspaceTemp.path, sources);
		const generation = await generationFromSources(workspaceTemp.path, sources);
		const readActivated = vi.fn(async () => generation);
		const baseline = await grepWorkspaceFiles(workspaceTemp.path, { query: "target" });
		const inactiveQuery = createRepoMapFileToolQuery(() => [], { readActivated });
		expect(await grepWorkspaceFiles(workspaceTemp.path, { query: "target" }, undefined, { repoMap: inactiveQuery })).toEqual(baseline);
		expect(readActivated).not.toHaveBeenCalled();
		const query = createRepoMapFileToolQuery(() => [activationEntry(generation.metadata)], { readActivated });
		const result = await grepWorkspaceFiles(workspaceTemp.path, { query: "target" }, undefined, { repoMap: query });
		if (result.status === "failed") throw new Error(result.error.message);
		expect(result.strategy).toContain("repo-map");
		expect(formatCompactGrepResult(result)).toContain("<grep repo-map");
		expect(result.regions.map((region) => region.reasons).flat()).toEqual(expect.arrayContaining(["definition", "caller"]));
		expect(result.regions.find((region) => region.path === "b.ts")?.content).toContain("function target");

		await writeFile(path.join(workspaceTemp.path, "b.ts"), "export function replacement() { return 2; }\n");
		clearGrepIndex();
		const staleResult = await grepWorkspaceFiles(workspaceTemp.path, { path: "b.ts", query: "target" }, undefined, { repoMap: query });
		if (staleResult.status === "failed") throw new Error(staleResult.error.message);
		expect(staleResult.strategy).not.toContain("repo-map");
		expect(staleResult.regions).toEqual([]);
		expect(JSON.stringify(staleResult)).not.toContain("return 1");
	});

	it("Repo Map candidates enhance literal/regex within existing result and token limits", async () => {
		const sources = new Map([
			["a.ts", "export function Needle() { return 'literalNeedle'; }\n"],
			["b.ts", "export function caller() { return Needle(); }\n"],
		]);
		await writeSources(workspaceTemp.path, sources);
		const generation = await generationFromSources(workspaceTemp.path, sources);
		const query = createRepoMapFileToolQuery(() => [activationEntry(generation.metadata)], { async readActivated() { return generation; } });
		for (const [match, text] of [["literal", "literalNeedle"], ["regex", "literalN.*"]] as const) {
			const result = await grepWorkspaceFiles(workspaceTemp.path, { query: text, match }, undefined, { repoMap: query });
			if (result.status === "failed") throw new Error(result.error.message);
			expect(result.regions.length).toBeGreaterThan(0);
			expect(result.regions.length).toBeLessThanOrEqual(8);
			expect(result.approx_tokens).toBeLessThanOrEqual(1600);
			expect(result.strategy).toContain("repo-map");
			expect(result.regions.every((region) => (region.match_lines?.length ?? 0) > 0)).toBe(true);
		}
	});
});

async function generationFromSources(root: string, sources: ReadonlyMap<string, string>): Promise<RepoMapGeneration> {
	const files = [...sources].map(([filePath, text]) => fileRecord(filePath, text));
	const indexed = await indexRepoMapSymbols({
		root,
		files,
		concurrency: 2,
		async readText(absolutePath) {
			const value = sources.get(path.relative(root, absolutePath).replaceAll(path.sep, "/"));
			if (value === undefined) throw new Error("missing source");
			return value;
		},
	});
	const mapId = "a".repeat(64);
	const generation = "b".repeat(64);
	const edges = buildRepoMapRelationships({ mapId, files, symbols: indexed.symbols, imports: indexed.imports });
	const metadata: RepoMapMetadata = {
		schemaVersion: 5,
		mapId,
		repositoryRoot: root,
		worktreeRoot: root,
		gitCommonDir: path.join(root, ".git"),
		generation,
		createdAt: "2026-07-17T00:00:00.000Z",
		updatedAt: "2026-07-17T00:00:00.000Z",
		freshness: "fresh",
		fileCount: files.length,
		indexedFileCount: files.length,
		parsedFileCount: files.length,
		unsupportedFileCount: 0,
		parseErrorFileCount: 0,
		symbolCount: indexed.symbols.length,
		testNodeCount: 0,
		edgeCount: edges.length,
		aliasCount: 0,
		tooLargeFileCount: 0,
		diagnosticCount: 0,
		configFingerprint: "config",
		ignoreFingerprint: "ignore",
		parserFingerprint: "parser",
	};
	return { metadata, files, symbols: indexed.symbols, tests: [], architecture: [], aliases: [], edges, diagnostics: [] };
}
