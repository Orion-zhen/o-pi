import { mkdir, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { defaultFileToolsConfig } from "../../src/file-tools/config.js";
import { createIgnoreSnapshot, defaultIgnoreEngine } from "../../src/file-tools/ignore/ignore-engine.js";
import { defaultRepoMapConfig } from "../../src/repo-map/config.js";
import { RepoMapError } from "../../src/repo-map/errors.js";
import { initializeRepoMap, readActivatedRepoMap, type RepoMapServiceDependencies } from "../../src/repo-map/service.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-repo-service-");
const execFileAsync = promisify(execFile);
const gitAvailable = await hasGit();
preserveEnv(
	"PI_REPO_MAP_CACHE_DIR",
	"PI_REPO_MAP_CONFIG",
	"PI_FILE_TOOLS_CONFIG",
	"PI_FILE_TOOLS_PROJECT_CONFIG",
	"PI_FILE_TOOLS_PROJECT_ROOT",
);

function dependencies(overrides: Partial<RepoMapServiceDependencies> = {}): Partial<RepoMapServiceDependencies> {
	const root = path.join(temp.path, "repo");
	return {
		async detectRepository() {
			return { repositoryRoot: root, worktreeRoot: root, gitCommonDir: path.join(root, ".git"), headRevision: "a".repeat(40) };
		},
		async readHeadRevision() { return "a".repeat(40); },
		async loadRepoMapConfig() { return defaultRepoMapConfig(); },
		async loadFileToolsConfig() { return defaultFileToolsConfig(); },
		async createIgnoreSnapshot(scanRoot, config) {
			defaultIgnoreEngine.invalidate();
			return await createIgnoreSnapshot(scanRoot, config);
		},
		cacheRoot: () => path.join(temp.path, "cache"),
		now: () => new Date("2026-07-17T00:00:00.000Z"),
		...overrides,
	};
}

describe("Repo Map initialization service", () => {
	it.skipIf(!gitAvailable)("runs the real Git/config/ignore/storage boundaries in a temporary repository", async () => {
		const root = path.join(temp.path, "real-repo");
		await mkdir(root);
		await execFileAsync("git", ["init", "--quiet", root]);
		await writeFile(path.join(root, "tracked.ts"), "export const value = 1;\n");
		process.env["PI_REPO_MAP_CACHE_DIR"] = path.join(temp.path, "real-cache");
		process.env["PI_REPO_MAP_CONFIG"] = path.join(temp.path, "missing-repo-map.jsonc");
		process.env["PI_FILE_TOOLS_CONFIG"] = path.join(temp.path, "missing-file-tools.jsonc");
		delete process.env["PI_FILE_TOOLS_PROJECT_CONFIG"];
		delete process.env["PI_FILE_TOOLS_PROJECT_ROOT"];
		const result = await initializeRepoMap({ cwd: root });
		expect(result.identity.repositoryRoot).toBe(root);
		expect(result.metadata).toMatchObject({ fileCount: 1, indexedFileCount: 1, parsedFileCount: 1, symbolCount: 1 });
		expect(result.metadata.edgeCount).toBeGreaterThan(2);
	});
	it("builds, persists, and reuses a symbol graph generation", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
		const first = await initializeRepoMap({ cwd: root }, dependencies());
		expect(first.reusedGeneration).toBe(false);
		expect(first.metadata).toMatchObject({ fileCount: 1, indexedFileCount: 1, parsedFileCount: 1, symbolCount: 1, freshness: "fresh" });
		expect(first.metadata.edgeCount).toBeGreaterThan(2);
		const second = await initializeRepoMap({ cwd: root }, dependencies());
		expect(second.reusedGeneration).toBe(true);
		expect(second.metadata.generation).toBe(first.metadata.generation);
		expect(second.summary).toMatchObject({ reused: 1, reusedParsed: 1, hashed: 0, added: 0, changed: 0, removed: 0 });
	});

	it("skips every graph builder and commit when the repository is unchanged", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
		const first = await initializeRepoMap({ cwd: root }, dependencies());
		const indexSymbols = vi.fn(async () => { throw new Error("unexpected symbol indexing"); });
		const buildArchitecture = vi.fn(async () => { throw new Error("unexpected architecture indexing"); });
		const buildTestGraph = vi.fn(async () => { throw new Error("unexpected test indexing"); });
		const buildRelationships = vi.fn(async () => { throw new Error("unexpected relationship indexing"); });
		const buildLexicalAliases = vi.fn(async () => { throw new Error("unexpected lexical indexing"); });
		const commit = vi.fn(async () => { throw new Error("unexpected commit"); });

		const result = await initializeRepoMap({ cwd: root, mode: "refresh" }, dependencies({
			indexSymbols,
			buildArchitecture,
			buildTestGraph,
			buildRelationships,
			buildLexicalAliases,
			commit,
		}));

		expect(result).toMatchObject({ reusedGeneration: true, metadata: { generation: first.metadata.generation } });
		for (const skipped of [indexSymbols, buildArchitecture, buildTestGraph, buildRelationships, buildLexicalAliases, commit]) expect(skipped).not.toHaveBeenCalled();
	});

	it("persists symbols for every supported language", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		for (const [name, source] of [
			["a.ts", "export function tsSymbol() {}\n"],
			["a.tsx", "export function tsxSymbol() { return <div />; }\n"],
			["a.js", "export function jsSymbol() {}\n"],
			["a.jsx", "export function jsxSymbol() { return <div />; }\n"],
			["a.py", "def py_symbol():\n  pass\n"],
			["a.go", "package a\nfunc GoSymbol() {}\n"],
			["a.rs", "pub fn rust_symbol() {}\n"],
		] as const) await writeFile(path.join(root, name), source);
		const result = await initializeRepoMap({ cwd: root }, dependencies());
		const generation = await readActivatedRepoMap({
			root,
			mapId: result.metadata.mapId,
			generation: result.metadata.generation,
		}, path.join(temp.path, "cache"));
		expect(result.metadata).toMatchObject({ parsedFileCount: 7, unsupportedFileCount: 0, parseErrorFileCount: 0, symbolCount: 7 });
		expect(new Set(generation?.symbols.map((symbol) => symbol.fileId))).toEqual(new Set(["ts", "tsx", "js", "jsx", "py", "go", "rs"].map((extension) => `file:a.${extension}`)));
	});

	it("rehashes only a changed file and rebuilds a corrupt current generation", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "a"), "a");
		await writeFile(path.join(root, "b"), "b");
		const first = await initializeRepoMap({ cwd: root }, dependencies());
		await writeFile(path.join(root, "b"), "changed-size");
		const changed = await initializeRepoMap({ cwd: root }, dependencies());
		expect(changed.summary).toMatchObject({ reused: 1, hashed: 1, changed: 1 });
		await writeFile(
			path.join(temp.path, "cache", changed.metadata.mapId, "generations", changed.metadata.generation, "files.json"),
			"corrupt",
		);
		const rebuilt = await initializeRepoMap({ cwd: root }, dependencies());
		expect(rebuilt.metadata.generation).toBe(changed.metadata.generation);
		expect(rebuilt.reusedGeneration).toBe(false);
		expect(rebuilt.summary.hashed).toBe(2);
		for (const snapshot of ["symbols.json", "edges.json"]) {
			await writeFile(
				path.join(temp.path, "cache", rebuilt.metadata.mapId, "generations", rebuilt.metadata.generation, snapshot),
				"corrupt",
			);
			const graphRebuilt = await initializeRepoMap({ cwd: root }, dependencies());
			expect(graphRebuilt).toMatchObject({ reusedGeneration: false, metadata: { generation: rebuilt.metadata.generation } });
		}
		expect(first.metadata.generation).not.toBe(changed.metadata.generation);
	});

	it("rejects HEAD changes without committing", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(root, { recursive: true });
		await writeFile(path.join(root, "a"), "a");
		await expect(initializeRepoMap({ cwd: root }, dependencies({
			async readHeadRevision() { return "b".repeat(40); },
		}))).rejects.toMatchObject({ code: "REPOSITORY_CHANGED_DURING_SCAN" });
	});

	it("propagates config, scan-limit, and cancellation errors", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(root, { recursive: true });
		await writeFile(path.join(root, "a"), "a");
		await expect(initializeRepoMap({ cwd: root }, dependencies({
			async loadRepoMapConfig() { throw new RepoMapError("CONFIG_ERROR", "bad config"); },
		}))).rejects.toMatchObject({ code: "CONFIG_ERROR" });
		await writeFile(path.join(root, "b"), "b");
		await expect(initializeRepoMap({ cwd: root }, dependencies({
			async loadRepoMapConfig() {
				const config = defaultRepoMapConfig();
				config.scan.max_files = 1;
				return config;
			},
		}))).rejects.toMatchObject({ code: "SCAN_LIMIT_EXCEEDED" });
		const controller = new AbortController();
		controller.abort();
		await expect(initializeRepoMap({ cwd: root, signal: controller.signal }, dependencies())).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
	});

	it("does not commit when cancellation arrives after scanning", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(root, { recursive: true });
		await writeFile(path.join(root, "a.ts"), "export function a() {}\n");
		const controller = new AbortController();
		await expect(initializeRepoMap({ cwd: root, signal: controller.signal }, dependencies({
			async indexSymbols() {
				controller.abort();
				return {
					symbols: [], imports: [], diagnostics: [], parsedFileCount: 0, unsupportedFileCount: 0,
					parseErrorFileCount: 0, reusedParsedFileCount: 0,
				};
			},
		}))).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
		await expect(stat(path.join(temp.path, "cache"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

async function hasGit(): Promise<boolean> {
	try {
		await execFileAsync("git", ["--version"]);
		return true;
	} catch {
		return false;
	}
}
