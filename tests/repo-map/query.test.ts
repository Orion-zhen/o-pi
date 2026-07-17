import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearGrepIndexForTests } from "../../src/file-tools/grep/indexer.js";
import { findWorkspaceFiles } from "../../src/file-tools/tools/find.js";
import { grepWorkspaceFiles } from "../../src/file-tools/tools/grep.js";
import { REPO_MAP_SESSION_ENTRY } from "../../src/repo-map/activation.js";
import { createRepoMapFileToolQuery } from "../../src/repo-map/file-tool-query.js";
import { buildRepoMapRelationships } from "../../src/repo-map/relationship-indexer.js";
import { RepoMapQueryIndex } from "../../src/repo-map/query.js";
import { indexRepoMapSymbols } from "../../src/repo-map/symbol-indexer.js";
import type { RepoMapGeneration } from "../../src/repo-map/storage.js";
import type { RepoMapFileRecord, RepoMapMetadata } from "../../src/repo-map/types.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

const workspaceTemp = useTempDir("o-pi-repo-query-");
const configTemp = useTempDir("o-pi-repo-query-config-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(async () => {
	await writeFile(path.join(configTemp.path, "file-tools.jsonc"), JSON.stringify({
		version: 1,
		blocked_path: [".git/"],
		ignored_path: [],
		ignore: { builtin_profile: "none", gitignore: false },
		limits: { find_result_limit: 8, grep_result_limit: 8, grep_output_token_budget: 1600 },
	}));
	process.env.PI_FILE_TOOLS_CONFIG = path.join(configTemp.path, "file-tools.jsonc");
	clearGrepIndexForTests();
});

describe("Repo Map Phase 3 query and file-tool integration", () => {
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

		const active = createRepoMapFileToolQuery(() => [activationEntry(generation)], { readActivated });
		expect(await active.query({ requestedPath: workspaceTemp.path, query: "Target", limit: 5 })).toMatchObject({ root: workspaceTemp.path });
		expect(await active.query({ requestedPath: configTemp.path, query: "Target", limit: 5 })).toBeUndefined();
		expect(await createRepoMapFileToolQuery(() => [activationEntry(generation)], { async readActivated() { return undefined; } })
			.query({ requestedPath: workspaceTemp.path, query: "Target", limit: 5 })).toBeUndefined();
		const mismatched = { ...generation, metadata: { ...generation.metadata, generation: "c".repeat(64) } };
		expect(await createRepoMapFileToolQuery(() => [activationEntry(generation)], { async readActivated() { return mismatched; } })
			.query({ requestedPath: workspaceTemp.path, query: "Target", limit: 5 })).toBeUndefined();
		const stale = { ...generation, metadata: { ...generation.metadata, freshness: "stale" as const } };
		expect(await createRepoMapFileToolQuery(() => [activationEntry(generation)], { async readActivated() { return stale; } })
			.query({ requestedPath: workspaceTemp.path, query: "Target", limit: 5 })).toBeUndefined();
		expect(await createRepoMapFileToolQuery(() => [activationEntry(generation)], { async readActivated() { throw new Error("corrupt"); } })
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

		const activeQuery = createRepoMapFileToolQuery(() => [activationEntry(generation)], { readActivated });
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
		const query = createRepoMapFileToolQuery(() => [activationEntry(generation)], { async readActivated() { return generation; } });
		const result = await grepWorkspaceFiles(workspaceTemp.path, { query: "target" }, undefined, { repoMap: query });
		if (result.status === "failed") throw new Error(result.error.message);
		expect(result.strategy).toContain("repo-map");
		expect(result.regions.map((region) => region.reasons).flat()).toEqual(expect.arrayContaining(["definition", "caller"]));
		expect(result.regions.find((region) => region.path === "b.ts")?.content).toContain("function target");

		await writeFile(path.join(workspaceTemp.path, "b.ts"), "export function replacement() { return 2; }\n");
		clearGrepIndexForTests();
		const staleResult = await grepWorkspaceFiles(workspaceTemp.path, { path: "b.ts", query: "target" }, undefined, { repoMap: query });
		if (staleResult.status === "failed") throw new Error(staleResult.error.message);
		expect(staleResult.strategy).not.toContain("repo-map");
		expect(staleResult.regions).toEqual([]);
		expect(JSON.stringify(staleResult)).not.toContain("return 1");
	});

	it("Repo Map candidates share existing result and token limits without dropping literal/regex hits", async () => {
		const sources = new Map([
			["a.ts", "export function Needle() { return 'literalNeedle'; }\n"],
			["b.ts", "export function caller() { return Needle(); }\n"],
		]);
		await writeSources(workspaceTemp.path, sources);
		const generation = await generationFromSources(workspaceTemp.path, sources);
		const query = createRepoMapFileToolQuery(() => [activationEntry(generation)], { async readActivated() { return generation; } });
		for (const [match, text] of [["literal", "literalNeedle"], ["regex", "literalN.*"]] as const) {
			const result = await grepWorkspaceFiles(workspaceTemp.path, { query: text, match }, undefined, { repoMap: query });
			if (result.status === "failed") throw new Error(result.error.message);
			expect(result.regions.length).toBeGreaterThan(0);
			expect(result.regions.length).toBeLessThanOrEqual(8);
			expect(result.approx_tokens).toBeLessThanOrEqual(1600);
			expect(result.strategy).not.toContain("repo-map");
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

async function writeSources(root: string, sources: ReadonlyMap<string, string>): Promise<void> {
	for (const [filePath, source] of sources) {
		await mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
		await writeFile(path.join(root, filePath), source);
	}
}

function fileRecord(filePath: string, text: string): RepoMapFileRecord {
	return {
		id: `file:${filePath}`,
		path: filePath,
		size: Buffer.byteLength(text),
		mtimeMs: 1,
		status: "indexed",
		contentHash: createHash("sha256").update(text).digest("hex"),
	};
}

function activationEntry(generation: RepoMapGeneration): SessionEntry {
	return {
		type: "custom",
		id: "activation",
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
