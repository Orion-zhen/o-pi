import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createFileIdentity, createSymbolId } from "../../src/code-index/identity.js";
import { createRepoMapId } from "../../src/repo-map/identity.js";
import { calculateGeneration, commitGeneration, readCurrentGeneration, readGeneration } from "../../src/repo-map/storage.js";
import type { RepoMapArchitectureNode, RepoMapEdge, RepoMapFileRecord, RepoMapLexicalAlias, RepoMapMetadata, RepoMapSymbolNode } from "../../src/repo-map/types.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-repo-storage-");
const root = "/canonical/repo";
const gitCommonDir = "/canonical/repo/.git";
const mapId = createRepoMapId({ worktreeRoot: root, gitCommonDir });

describe("Repo Map generation storage", () => {
	it("writes a complete generation, switches CURRENT, and reuses immutable content", async () => {
		const files = [indexed("z.ts", "b"), indexed("a.ts", "a")].sort((a, b) => a.path.localeCompare(b.path));
		const metadata = makeMetadata(files);
		const first = await commitGeneration({ cacheRoot: temp.path, maxGenerations: 2, metadata, files, symbols: [], tests: [], architecture: [], aliases: [], edges: [], diagnostics: [] });
		expect(first.reused).toBe(false);
		expect((await readFile(path.join(temp.path, mapId, "CURRENT"), "utf8")).trim()).toBe(metadata.generation);
		expect(await readCurrentGeneration(temp.path, mapId, root)).toEqual(first.generation);
		const second = await commitGeneration({ cacheRoot: temp.path, maxGenerations: 2, metadata: { ...metadata, updatedAt: "2030-01-01T00:00:00.000Z" }, files, symbols: [], tests: [], architecture: [], aliases: [], edges: [], diagnostics: [] });
		expect(second.reused).toBe(true);
		expect(second.generation.metadata.updatedAt).toBe(metadata.updatedAt);
		const persisted = JSON.parse(await readFile(path.join(temp.path, mapId, "generations", metadata.generation, "files.json"), "utf8")) as Array<{ path: string }>;
		expect(persisted.map((file) => file.path)).toEqual(["a.ts", "z.ts"]);
	});

	it.each(["../escape", "/absolute", "not-a-hash"])("rejects unsafe CURRENT value %s", async (current) => {
		await mkdir(path.join(temp.path, mapId), { recursive: true });
		await writeFile(path.join(temp.path, mapId, "CURRENT"), current);
		expect(await readCurrentGeneration(temp.path, mapId, root)).toBeUndefined();
	});

	it.each(["symbols.json", "edges.json"])("persists the graph and rejects corrupt %s", async (corruptFile) => {
		const file = indexed("a.ts", "export function a() {}");
		const files = [file];
		const symbol = makeSymbol(file);
		const edge = makeContainsEdge(file, symbol);
		const metadata = makeMetadata(files, "2026-01-01T00:00:00.000Z", [symbol], [edge]);
		await commitGeneration({ cacheRoot: temp.path, maxGenerations: 2, metadata, files, symbols: [symbol], tests: [], architecture: [], aliases: [], edges: [edge], diagnostics: [] });
		const directory = path.join(temp.path, mapId, "generations", metadata.generation);
		expect(await readGeneration(temp.path, mapId, metadata.generation, root)).toMatchObject({ symbols: [symbol], edges: [edge] });
		await writeFile(path.join(directory, corruptFile), "[]\n");
		expect(await readGeneration(temp.path, mapId, metadata.generation, root)).toBeUndefined();
	});

	it("includes stable symbol, edge, and diagnostic snapshots in the generation hash", () => {
		const file = indexed("a.ts", "export function a() {}");
		const symbol = makeSymbol(file);
		const edge = makeContainsEdge(file, symbol);
		const base = {
			mapId,
			configFingerprint: "c".repeat(64),
			ignoreFingerprint: "ignore",
			parserFingerprint: "format",
			files: [file],
			symbols: [symbol],
			tests: [],
			aliases: [],
			architecture: [],
			edges: [edge],
			diagnostics: [],
		};
		const generation = calculateGeneration(base);
		const alias: RepoMapLexicalAlias = { term: "repo client", canonical: "repository client", target: file.id, source: "file-path", confidence: 0.78, evidence: [{ path: file.path, startLine: 1, endLine: 1, startByte: 0, endByte: 0 }] };
		expect(calculateGeneration({ ...base, symbols: [{ ...symbol, signature: "changed" }] })).not.toBe(generation);
		expect(calculateGeneration({ ...base, aliases: [alias] })).not.toBe(generation);
		expect(calculateGeneration({ ...base, edges: [{ ...edge, confidence: 0.5 }] })).not.toBe(generation);
		expect(calculateGeneration({ ...base, architecture: [packageNode()] })).not.toBe(generation);
		expect(calculateGeneration({ ...base, diagnostics: [{ code: "PARSER_ERROR", message: "failed", path: "a.ts" }] })).not.toBe(generation);
	});

	it("persists architecture nodes and rejects a corrupt architecture snapshot", async () => {
		const files = [indexed("package.json", "{}")];
		const architecture = [packageNode()];
		const metadata = makeMetadata(files, "2026-01-01T00:00:00.000Z", [], [], architecture);
		await commitGeneration({ cacheRoot: temp.path, maxGenerations: 2, metadata, files, symbols: [], tests: [], architecture, aliases: [], edges: [], diagnostics: [] });
		const directory = path.join(temp.path, mapId, "generations", metadata.generation);
		expect(await readGeneration(temp.path, mapId, metadata.generation, root)).toMatchObject({ architecture });
		await writeFile(path.join(directory, "architecture.json"), JSON.stringify([{ ...architecture[0], name: "" }]));
		expect(await readGeneration(temp.path, mapId, metadata.generation, root)).toBeUndefined();
	});

	it("persists aliases in the generation hash and rejects dangling alias targets", async () => {
		const files = [indexed("repo-client.ts", "export const repoClient = true")];
		const file = files[0];
		if (file?.contentHash === undefined) throw new Error("missing indexed file hash");
		const aliases: RepoMapLexicalAlias[] = [{
			term: "repo client",
			canonical: "repository client",
			target: file.id,
			source: "file-path",
			confidence: 0.78,
			evidence: [{ path: "repo-client.ts", textHash: file.contentHash, startLine: 1, endLine: 1, startByte: 0, endByte: 0 }],
		}];
		const metadata = makeMetadata(files, "2026-01-01T00:00:00.000Z", [], [], [], aliases);
		await commitGeneration({ cacheRoot: temp.path, maxGenerations: 2, metadata, files, symbols: [], tests: [], architecture: [], aliases, edges: [], diagnostics: [] });
		expect(await readGeneration(temp.path, mapId, metadata.generation, root)).toMatchObject({ aliases });
		const directory = path.join(temp.path, mapId, "generations", metadata.generation);
		await writeFile(path.join(directory, "aliases.json"), JSON.stringify([{ ...aliases[0], target: "file:missing.ts" }]));
		expect(await readGeneration(temp.path, mapId, metadata.generation, root)).toBeUndefined();
	});

	it("rejects corrupt metadata, files, schema, map, and generation mismatches", async () => {
		const files = [indexed("a.ts", "a")];
		const metadata = makeMetadata(files);
		await commitGeneration({ cacheRoot: temp.path, maxGenerations: 2, metadata, files, symbols: [], tests: [], architecture: [], aliases: [], edges: [], diagnostics: [] });
		const directory = path.join(temp.path, mapId, "generations", metadata.generation);
		await writeFile(path.join(directory, "metadata.json"), JSON.stringify({ ...metadata, schemaVersion: 1 }));
		expect(await readGeneration(temp.path, mapId, metadata.generation, root)).toBeUndefined();
		await writeFile(path.join(directory, "metadata.json"), JSON.stringify(metadata));
		await writeFile(path.join(directory, "files.json"), JSON.stringify([{ ...files[0], unexpected: true }]));
		expect(await readGeneration(temp.path, mapId, metadata.generation, root)).toBeUndefined();
		await writeFile(path.join(directory, "files.json"), JSON.stringify([{ ...files[0], path: "../escape" }]));
		expect(await readGeneration(temp.path, mapId, metadata.generation, root)).toBeUndefined();
		expect(await readGeneration(temp.path, "b".repeat(64), metadata.generation, root)).toBeUndefined();
		expect(await readGeneration(temp.path, mapId, "c".repeat(64), root)).toBeUndefined();
	});

	it("preserves CURRENT on cancellation or invalid input", async () => {
		const files = [indexed("a", "a")];
		const metadata = makeMetadata(files);
		await commitGeneration({ cacheRoot: temp.path, maxGenerations: 2, metadata, files, symbols: [], tests: [], architecture: [], aliases: [], edges: [], diagnostics: [] });
		const controller = new AbortController();
		controller.abort();
		await expect(commitGeneration({
			cacheRoot: temp.path,
			maxGenerations: 2,
			metadata: { ...metadata, generation: "b".repeat(64) },
			files,
			symbols: [],
			tests: [],
			architecture: [],
			aliases: [],
			edges: [],
			diagnostics: [],
			signal: controller.signal,
		})).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
		expect((await readFile(path.join(temp.path, mapId, "CURRENT"), "utf8")).trim()).toBe(metadata.generation);
	});

	it("rejects a symlinked map cache directory", async () => {
		const cacheRoot = path.join(temp.path, "cache");
		const outside = path.join(temp.path, "outside");
		await mkdir(cacheRoot);
		await mkdir(outside);
		try {
			await symlink(outside, path.join(cacheRoot, mapId));
		} catch {
			return;
		}
		const files = [indexed("a", "a")];
		await expect(commitGeneration({ cacheRoot, maxGenerations: 2, metadata: makeMetadata(files), files, symbols: [], tests: [], architecture: [], aliases: [], edges: [], diagnostics: [] }))
			.rejects.toMatchObject({ code: "CACHE_ERROR" });
		expect(await readdir(outside)).toEqual([]);
	});

	it("keeps the current generation while cleaning old generations", async () => {
		for (const [index, name] of ["one", "two", "three"].entries()) {
			const files = [indexed(name, String(index))];
			const metadata = makeMetadata(files, `2026-01-0${index + 1}T00:00:00.000Z`);
			await commitGeneration({ cacheRoot: temp.path, maxGenerations: 2, metadata, files, symbols: [], tests: [], architecture: [], aliases: [], edges: [], diagnostics: [] });
		}
		const current = (await readFile(path.join(temp.path, mapId, "CURRENT"), "utf8")).trim();
		const generations = (await readdir(path.join(temp.path, mapId, "generations"))).filter((name) => /^[0-9a-f]{64}$/u.test(name));
		expect(generations).toHaveLength(2);
		expect(generations).toContain(current);
	});

	it("rejects a concurrent commit while the inter-process lock is held", async () => {
		const files = [indexed("locked.ts", "locked")];
		const metadata = makeMetadata(files);
		const input = { cacheRoot: temp.path, maxGenerations: 2, metadata, files, symbols: [], tests: [], architecture: [], aliases: [], edges: [], diagnostics: [] };
		await commitGeneration(input);
		const lockDirectory = path.join(temp.path, mapId, "COMMIT_LOCK");
		await mkdir(lockDirectory);
		try {
			await expect(commitGeneration(input)).rejects.toMatchObject({ code: "CACHE_ERROR" });
		} finally {
			await rm(lockDirectory, { recursive: true, force: true });
		}
	});
});

function indexed(filePath: string, content: string): RepoMapFileRecord {
	return { ...createFileIdentity(filePath), size: content.length, mtimeMs: 1, status: "indexed", contentHash: hashFor(content) };
}

function makeMetadata(
	files: RepoMapFileRecord[],
	now = "2026-01-01T00:00:00.000Z",
	symbols: RepoMapSymbolNode[] = [],
	edges: RepoMapEdge[] = [],
	architecture: RepoMapArchitectureNode[] = [],
	aliases: RepoMapLexicalAlias[] = [],
): RepoMapMetadata {
	const generation = calculateGeneration({
		mapId,
		configFingerprint: "c".repeat(64),
		ignoreFingerprint: "ignore",
		parserFingerprint: "format",
		headRevision: "d".repeat(40),
		files,
		symbols,
		tests: [],
		aliases,
		edges,
		architecture,
		diagnostics: [],
	});
	return {
		schemaVersion: 5,
		mapId,
		repositoryRoot: root,
		worktreeRoot: root,
		gitCommonDir,
		generation,
		createdAt: now,
		updatedAt: now,
		freshness: "fresh",
		fileCount: files.length,
		indexedFileCount: files.length,
		parsedFileCount: 0,
		unsupportedFileCount: files.length,
		parseErrorFileCount: 0,
		symbolCount: symbols.length,
		testNodeCount: 0,
		edgeCount: edges.length,
		aliasCount: aliases.length,
		tooLargeFileCount: 0,
		diagnosticCount: 0,
		gitRevision: "d".repeat(40),
		configFingerprint: "c".repeat(64),
		ignoreFingerprint: "ignore",
		parserFingerprint: "format",
	};
}

function packageNode(): RepoMapArchitectureNode {
	return { kind: "package", id: "package:root", name: "repo", rootPath: ".", ecosystem: "npm", manifestPath: "package.json", source: "manifest", confidence: 1 };
}

function makeSymbol(file: RepoMapFileRecord): RepoMapSymbolNode {
	const symbol = { fileId: file.id, kind: "function", name: "a", qualifiedName: "a", startByte: 0 };
	return {
		kind: "symbol",
		id: createSymbolId(symbol),
		fileId: file.id,
		symbolKind: symbol.kind,
		name: symbol.name,
		qualifiedName: symbol.qualifiedName,
		signature: "export function a() {}",
		startLine: 1,
		endLine: 1,
		startByte: 0,
		endByte: file.size,
		definitions: ["a"],
		references: ["a"],
		calls: ["a"],
		imports: [],
	};
}

function makeContainsEdge(file: RepoMapFileRecord, symbol: RepoMapSymbolNode): RepoMapEdge {
	return {
		kind: "contains",
		from: file.id,
		to: symbol.id,
		resolution: "syntactic",
		source: "tree-sitter",
		confidence: 1,
		evidence: [{ path: file.path, ...(file.contentHash !== undefined ? { textHash: file.contentHash } : {}), startLine: 1, endLine: 1, startByte: 0, endByte: file.size }],
	};
}

function hashFor(value: string): string {
	return Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
}
