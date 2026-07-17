import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultFileToolsConfig } from "../../src/file-tools/config.js";
import { findWorkspaceFiles } from "../../src/file-tools/tools/find.js";
import { grepWorkspaceFiles } from "../../src/file-tools/tools/grep.js";
import { readWorkspaceFile } from "../../src/file-tools/tools/read.js";
import { createIgnoreSnapshot, defaultIgnoreEngine } from "../../src/file-tools/ignore/ignore-engine.js";
import { REPO_MAP_SESSION_ENTRY } from "../../src/repo-map/activation.js";
import { buildRepoMapArchitecture } from "../../src/repo-map/architecture-indexer.js";
import { defaultRepoMapConfig } from "../../src/repo-map/config.js";
import { createRepoMapFileToolQuery } from "../../src/repo-map/file-tool-query.js";
import { buildRepoMapRelationships } from "../../src/repo-map/relationship-indexer.js";
import { RepoMapQueryIndex } from "../../src/repo-map/query.js";
import { initializeRepoMap, readActivatedRepoMap, type RepoMapServiceDependencies } from "../../src/repo-map/service.js";
import { indexRepoMapSymbols } from "../../src/repo-map/symbol-indexer.js";
import type { RepoMapGeneration } from "../../src/repo-map/storage.js";
import type { RepoMapFileRecord, RepoMapMetadata } from "../../src/repo-map/types.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-repo-phase5-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(async () => {
	const configPath = path.join(temp.path, "file-tools.jsonc");
	await writeFile(configPath, JSON.stringify({
		version: 1,
		blocked_path: [".git/"],
		ignored_path: [],
		ignore: { builtin_profile: "none", gitignore: false },
		limits: { read_lines: 20, read_bytes: 8192, find_result_limit: 20, grep_result_limit: 20 },
	}));
	process.env.PI_FILE_TOOLS_CONFIG = configPath;
});

describe("Repo Map Phase 5 architecture graph", () => {
	it("derives monorepo packages, components, manifest entrypoints, registrations, and public API", async () => {
		const sources = fixtureSources();
		const generation = await generationFromSources(temp.path, sources);
		const architecture = generation.architecture;
		const packages = architecture.filter((node) => node.kind === "package");
		expect(packages.map((node) => node.name)).toEqual(expect.arrayContaining(["workspace", "pkg-a", "pkg-b", "py-lib", "example.test/go-lib", "rust-lib"]));
		expect(packages.every((node) => node.source === "manifest" && node.confidence === 1)).toBe(true);
		expect(architecture).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "component", name: "src", source: "convention" }),
			expect.objectContaining({ kind: "entrypoint", entrypointType: "main", declaredTarget: "./src/index.ts" }),
			expect.objectContaining({ kind: "entrypoint", entrypointType: "bin", name: "workspace-cli" }),
			expect.objectContaining({ kind: "entrypoint", entrypointType: "test", name: "test" }),
			expect.objectContaining({ kind: "entrypoint", entrypointType: "bin", name: "py-cli", declaredTarget: "py_lib:main" }),
			expect.objectContaining({ kind: "entrypoint", entrypointType: "command", name: "serve" }),
			expect.objectContaining({ kind: "entrypoint", entrypointType: "tool", name: "fetch" }),
			expect.objectContaining({ kind: "entrypoint", entrypointType: "plugin", name: "sample" }),
		]));
		expect(architecture.find((node) => node.kind === "entrypoint" && node.entrypointType === "plugin" && node.name === "sample"))
			.toMatchObject({ source: "convention", confidence: 0.72 });
		for (const kind of ["declares-entrypoint", "declares-script", "registers-command", "registers-tool", "registers-plugin", "re-exports", "exports-publicly", "belongs-to"] as const) {
			expect(generation.edges.some((edge) => edge.kind === kind)).toBe(true);
		}
		expect(generation.edges.every((edge) => edge.evidence.length > 0 && edge.confidence >= 0 && edge.confidence <= 1)).toBe(true);
		const publicSymbol = generation.symbols.find((symbol) => symbol.name === "PublicThing");
		const internalSymbol = generation.symbols.find((symbol) => symbol.name === "secret");
		expect(publicSymbol?.visibility).toBe("public");
		expect(internalSymbol?.visibility).toBe("internal");
		expect(generation.edges).toContainEqual(expect.objectContaining({ kind: "belongs-to", from: publicSymbol?.id, to: expect.stringMatching(/^component:/u) }));
	});

	it("uses architecture relevance in query, find, grep, and compact read context while inactive behavior stays unchanged", async () => {
		const sources = fixtureSources();
		await writeSources(temp.path, sources);
		const generation = await generationFromSources(temp.path, sources);
		const index = new RepoMapQueryIndex(generation);
		expect(index.candidates("serve").candidates[0]).toMatchObject({ path: "agent/extensions/sample.ts", reasons: expect.arrayContaining(["registration"]) });
		expect(index.candidates("pkg-a").candidates.map((candidate) => candidate.path)).toContain("packages/a/src/index.ts");
		expect(index.definitions("PublicThing")[0]?.reasons).toEqual(expect.arrayContaining(["public api", "export"]));

		const readActivated = vi.fn(async () => generation);
		const inactive = createRepoMapFileToolQuery(() => [], { readActivated });
		const baseline = await findWorkspaceFiles(temp.path, { query: "serve" });
		expect(await findWorkspaceFiles(temp.path, { query: "serve" }, undefined, { repoMap: inactive })).toEqual(baseline);
		expect(readActivated).not.toHaveBeenCalled();

		const active = createRepoMapFileToolQuery(() => [activationEntry(generation)], { readActivated });
		const found = await findWorkspaceFiles(temp.path, { query: "serve" }, undefined, { repoMap: active });
		expect("status" in found ? [] : found.details.matches).toContainEqual({ path: "agent/extensions/sample.ts", kind: "file" });
		const grep = await grepWorkspaceFiles(temp.path, { query: "serve" }, undefined, { repoMap: active });
		if (grep.status === "failed") throw new Error(grep.error.message);
		expect(grep.strategy).toContain("repo-map");
		expect(grep.regions.flatMap((region) => region.reasons)).toContain("registration");
		const read = await readWorkspaceFile(temp.path, { path: "packages/a/src/impl.ts", start_line: 1, end_line: 1 }, { repoMap: active });
		if (!("content" in read) || "media_type" in read) throw new Error("partial read failed");
		expect(read.repo_map).toMatchObject({ package: "pkg-a", component: "src", publicApi: true });
	});

	it("recomputes manifest and registration facts atomically and leaves no dangling edge after deletion", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "single", main: "./src/index.ts" }));
		await mkdir(path.join(root, "src"), { recursive: true });
		await writeFile(path.join(root, "src/index.ts"), "export function oldApi() {}\nexport function extension(pi: any) { pi.registerCommand('old', {}); }\n");
		const first = await initializeRepoMap({ cwd: root }, dependencies(root));
		const firstGeneration = await readGeneration(root, first.metadata.mapId, first.metadata.generation);
		expect(firstGeneration.architecture.some((node) => node.kind === "entrypoint" && node.name === "old")).toBe(true);

		await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "single", exports: "./src/new.ts" }));
		await writeFile(path.join(root, "src/new.ts"), "export function newApi() {}\nexport function extension(pi: any) { pi.registerCommand('new', {}); }\n");
		await rm(path.join(root, "src/index.ts"));
		const refreshed = await initializeRepoMap({ cwd: root, mode: "refresh" }, dependencies(root));
		const generation = await readGeneration(root, refreshed.metadata.mapId, refreshed.metadata.generation);
		expect(refreshed.metadata.generation).not.toBe(first.metadata.generation);
		expect(generation.architecture.some((node) => node.kind === "entrypoint" && node.name === "new")).toBe(true);
		expect(generation.architecture.some((node) => node.kind === "entrypoint" && node.name === "old")).toBe(false);
		const ids = new Set([`repository:${generation.metadata.mapId}`, ...generation.files.map((file) => file.id), ...generation.symbols.map((symbol) => symbol.id), ...generation.architecture.map((node) => node.id)]);
		expect(generation.edges.every((edge) => ids.has(edge.from) && (ids.has(edge.to) || edge.to.startsWith("external:") || edge.to.startsWith("lexical:")))).toBe(true);
		expect(JSON.stringify(generation)).not.toContain("src/index.ts");
	});
});

function fixtureSources(): Map<string, string> {
	return new Map([
		["package.json", JSON.stringify({ name: "workspace", workspaces: ["packages/*"], main: "./src/index.ts", bin: { "workspace-cli": "./src/cli.ts" }, exports: { ".": "./src/index.ts" }, scripts: { test: "node ./src/test.ts", build: "tsc" } })],
		["src/index.ts", "export const root = true;\n"],
		["src/cli.ts", "export function cli() {}\n"],
		["src/test.ts", "export function testMain() {}\n"],
		["packages/a/package.json", JSON.stringify({ name: "pkg-a", exports: "./src/index.ts" })],
		["packages/a/src/index.ts", "export { PublicThing } from './impl';\n"],
		["packages/a/src/impl.ts", "export function PublicThing() {}\nfunction secret() {}\n"],
		["packages/b/package.json", JSON.stringify({ name: "pkg-b", module: "./src/index.ts" })],
		["packages/b/src/index.ts", "export default function start() {}\n"],
		["python/pyproject.toml", "[project]\nname = 'py-lib'\n[project.scripts]\npy-cli = 'py_lib:main'\n"],
		["go/go.mod", "module example.test/go-lib\n"],
		["rust/Cargo.toml", "[package]\nname = 'rust-lib'\n"],
		["agent/extensions/sample.ts", "export default function sample(pi: any) { pi.registerCommand('serve', {}); pi.registerTool({ name: 'fetch', execute() {} }); }\n"],
	]);
}

async function generationFromSources(root: string, sources: ReadonlyMap<string, string>): Promise<RepoMapGeneration> {
	const files = [...sources].map(([filePath, text]) => fileRecord(filePath, text)).sort((left, right) => left.path.localeCompare(right.path));
	const indexed = await indexRepoMapSymbols({ root, files, concurrency: 2, async readText(absolutePath) { return sources.get(path.relative(root, absolutePath).replaceAll(path.sep, "/")) ?? ""; } });
	const mapId = "a".repeat(64);
	const architecture = await buildRepoMapArchitecture({ root, mapId, files, symbols: indexed.symbols, async readText(absolutePath) { return sources.get(path.relative(root, absolutePath).replaceAll(path.sep, "/")) ?? ""; } });
	const edges = [...buildRepoMapRelationships({ mapId, files, symbols: architecture.symbols, imports: indexed.imports }), ...architecture.edges];
	const metadata: RepoMapMetadata = {
		schemaVersion: 5, mapId, repositoryRoot: root, worktreeRoot: root, gitCommonDir: path.join(root, ".git"), generation: "b".repeat(64),
		createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z", freshness: "fresh",
		fileCount: files.length, indexedFileCount: files.length, parsedFileCount: indexed.parsedFileCount, unsupportedFileCount: indexed.unsupportedFileCount,
		parseErrorFileCount: indexed.parseErrorFileCount, symbolCount: architecture.symbols.length, testNodeCount: 0, edgeCount: edges.length, aliasCount: 0, tooLargeFileCount: 0,
		diagnosticCount: architecture.diagnostics.length, configFingerprint: "config", ignoreFingerprint: "ignore", parserFingerprint: "parser",
	};
	return { metadata, files, symbols: architecture.symbols, tests: [], architecture: architecture.nodes, aliases: [], edges, diagnostics: architecture.diagnostics };
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
	return { type: "custom", id: "activation", parentId: null, timestamp: "t", customType: REPO_MAP_SESSION_ENTRY, data: { kind: "activation", root: generation.metadata.repositoryRoot, mapId: generation.metadata.mapId, generation: generation.metadata.generation, activatedAt: generation.metadata.updatedAt } };
}

function dependencies(root: string): Partial<RepoMapServiceDependencies> {
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

async function readGeneration(root: string, mapId: string, generation: string): Promise<RepoMapGeneration> {
	const value = await readActivatedRepoMap({ root, mapId, generation }, path.join(temp.path, "cache"));
	if (value === undefined) throw new Error("missing generation");
	return value;
}
