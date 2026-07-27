import { mkdir, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { analyzeCodeFile } from "../../src/code-index/parser.js";
import { defaultFileToolsConfig } from "../../src/file-tools/config.js";
import { defaultRepoMapConfig } from "../../src/repo-map/config/config.js";
import { RepoMapError } from "../../src/repo-map/core/errors.js";
import { scanRepoMap } from "../../src/repo-map/indexing/scanner.js";
import { indexRepoMapSymbols } from "../../src/repo-map/indexing/symbol-indexer.js";
import {
	initializeRepoMap,
	readActivatedRepoMap,
	refreshActivatedRepoMap,
	type RepoMapServiceDependencies,
} from "../../src/repo-map/runtime/service.js";
import { readCurrentGeneration } from "../../src/repo-map/storage/storage.js";
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

	it("uses a verified supplied generation and returns the committed generation without a full current read", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
		const first = await initializeRepoMap({ cwd: root }, dependencies());
		await writeFile(path.join(root, "a.ts"), "export const renamed = 2;\n");
		const readCurrent = vi.fn(async () => { throw new Error("unexpected full generation read"); });

		const refreshed = await refreshActivatedRepoMap({
			activation: {
				root,
				mapId: first.metadata.mapId,
				generation: first.metadata.generation,
				activatedAt: first.metadata.updatedAt,
			},
			previous: first.generation,
		}, dependencies({ readCurrent }));

		expect(readCurrent).not.toHaveBeenCalled();
		expect(refreshed.generation.metadata).toBe(refreshed.metadata);
		expect(refreshed.generation.symbols.map((symbol) => symbol.name)).toContain("renamed");
		expect(refreshed.metadata.generation).not.toBe(first.metadata.generation);
	});

	it.each(["CURRENT", "root", "map"] as const)("falls back to a verified disk read when supplied previous mismatches %s", async (mismatch) => {
		const root = path.join(temp.path, "repo");
		const cacheRoot = path.join(temp.path, "cache");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
		const first = await initializeRepoMap({ cwd: root }, dependencies());
		const previous = mismatch === "root"
			? { ...first.generation, metadata: { ...first.metadata, repositoryRoot: path.join(temp.path, "other") } }
			: mismatch === "map"
				? { ...first.generation, metadata: { ...first.metadata, mapId: "f".repeat(64) } }
				: first.generation;
		const readCurrent = vi.fn(async (resolvedCacheRoot: string, mapId: string, expectedRoot: string) =>
			await readCurrentGeneration(resolvedCacheRoot, mapId, expectedRoot));
		const readCurrentId = mismatch === "CURRENT"
			? vi.fn(async () => "f".repeat(64))
			: vi.fn(async () => first.metadata.generation);

		const refreshed = await refreshActivatedRepoMap({
			activation: {
				root,
				mapId: first.metadata.mapId,
				generation: first.metadata.generation,
				activatedAt: first.metadata.updatedAt,
			},
			previous,
		}, dependencies({ cacheRoot: () => cacheRoot, readCurrent, readCurrentId }));

		expect(readCurrent).toHaveBeenCalledOnce();
		expect(refreshed.generation).not.toBe(previous);
		expect(refreshed.metadata.generation).toBe(first.metadata.generation);
		if (mismatch === "CURRENT") expect(readCurrentId).toHaveBeenCalledOnce();
		else expect(readCurrentId).not.toHaveBeenCalled();
	});

	it("rechecks CURRENT under the map lock before reusing a supplied generation", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
		const first = await initializeRepoMap({ cwd: root }, dependencies());
		await writeFile(path.join(root, "a.ts"), "export const changed = 2;\n");
		const firstScanStarted = deferred<void>();
		const releaseFirstScan = deferred<void>();
		let scanCalls = 0;
		const readCurrent = vi.fn(async (cacheRoot: string, mapId: string, expectedRoot: string) =>
			await readCurrentGeneration(cacheRoot, mapId, expectedRoot));
		const deps = dependencies({
			readCurrent,
			async scan(input) {
				scanCalls += 1;
				if (scanCalls === 1) {
					firstScanStarted.resolve(undefined);
					await releaseFirstScan.promise;
				}
				return await scanRepoMap(input);
			},
		});
		const refreshInput = {
			activation: {
				root,
				mapId: first.metadata.mapId,
				generation: first.metadata.generation,
				activatedAt: first.metadata.updatedAt,
			},
			previous: first.generation,
		};

		const firstRefresh = refreshActivatedRepoMap(refreshInput, deps);
		await firstScanStarted.promise;
		const secondRefresh = refreshActivatedRepoMap(refreshInput, deps);
		releaseFirstScan.resolve(undefined);
		const [firstResult, secondResult] = await Promise.all([firstRefresh, secondRefresh]);

		expect(firstResult.metadata.generation).not.toBe(first.metadata.generation);
		expect(secondResult.metadata.generation).toBe(firstResult.metadata.generation);
		expect(readCurrent).toHaveBeenCalledOnce();
		expect(scanCalls).toBe(2);
	});

	it("forwards per-file parsing progress through initialization", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await Promise.all([
			writeFile(path.join(root, "a.ts"), "export const a = 1;\n"),
			writeFile(path.join(root, "b.ts"), "export const b = 2;\n"),
		]);
		const progress: Array<{ phase: string; completed?: number; total?: number }> = [];

		await initializeRepoMap({ cwd: root, onProgress(update) { progress.push(update); } }, dependencies());

		expect(progress.filter((update) => update.phase === "parsing")).toEqual([
			{ phase: "parsing", completed: 0, total: 2 },
			{ phase: "parsing", completed: 1, total: 2 },
			{ phase: "parsing", completed: 2, total: 2 },
		]);
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

	it("retains recovered symbols but marks incomplete syntax facts as partially stale", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(
			path.join(root, "extension.ts"),
			'export function setup() {\n  registerCommand("demo", () => {});\n',
		);

		const result = await initializeRepoMap({ cwd: root }, dependencies());
		const generation = await readActivatedRepoMap({
			root,
			mapId: result.metadata.mapId,
			generation: result.metadata.generation,
		}, path.join(temp.path, "cache"));

		expect(generation?.symbols.some((symbol) => symbol.name === "setup")).toBe(true);
		expect(generation?.diagnostics).toContainEqual(expect.objectContaining({
			code: "PARSER_SYNTAX_ERROR",
			path: "extension.ts",
		}));
		expect(result.metadata.freshness).toBe("partially_stale");
	});

	it("reuses an unchanged partially stale generation with stable syntax diagnostics", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "extension.ts"), "export function setup() {\n");
		const first = await initializeRepoMap({ cwd: root }, dependencies());
		const indexSymbols = vi.fn(async () => { throw new Error("unexpected symbol indexing"); });
		const buildArchitecture = vi.fn(async () => { throw new Error("unexpected architecture indexing"); });
		const buildTestGraph = vi.fn(async () => { throw new Error("unexpected test indexing"); });
		const buildRelationships = vi.fn(async () => { throw new Error("unexpected relationship indexing"); });
		const buildLexicalAliases = vi.fn(async () => { throw new Error("unexpected lexical indexing"); });
		const commit = vi.fn(async () => { throw new Error("unexpected commit"); });
		const progress: Array<{ phase: string; completed?: number; total?: number }> = [];

		const result = await initializeRepoMap({
			cwd: root,
			mode: "refresh",
			onProgress(update) { progress.push(update); },
		}, dependencies({ indexSymbols, buildArchitecture, buildTestGraph, buildRelationships, buildLexicalAliases, commit }));

		expect(result).toMatchObject({
			reusedGeneration: true,
			metadata: {
				generation: first.metadata.generation,
				freshness: "partially_stale",
				diagnosticCount: 1,
			},
			summary: { diagnostics: 1, reusedParsed: 1 },
		});
		for (const skipped of [indexSymbols, buildArchitecture, buildTestGraph, buildRelationships, buildLexicalAliases, commit]) expect(skipped).not.toHaveBeenCalled();
		expect(progress.filter((update) => update.phase === "parsing" || update.phase === "saving")).toEqual([
			{ phase: "parsing", completed: 1, total: 1 },
			{ phase: "saving" },
		]);
	});

	it("retains a stable syntax diagnostic without reparsing its file when another file changes", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await Promise.all([
			writeFile(path.join(root, "broken.ts"), "export function broken() {\n"),
			writeFile(path.join(root, "healthy.ts"), "export const healthy = 1;\n"),
		]);
		await initializeRepoMap({ cwd: root }, dependencies());
		await writeFile(path.join(root, "healthy.ts"), "export const healthy = 2;\n");
		const analyze = vi.fn(analyzeCodeFile);

		const result = await initializeRepoMap({ cwd: root, mode: "refresh" }, dependencies({
			async indexSymbols(input) {
				return await indexRepoMapSymbols({ ...input, analyze });
			},
		}));
		const generation = await readActivatedRepoMap({
			root,
			mapId: result.metadata.mapId,
			generation: result.metadata.generation,
		}, path.join(temp.path, "cache"));

		expect(analyze).toHaveBeenCalledTimes(1);
		expect(analyze).toHaveBeenCalledWith("healthy.ts", "export const healthy = 2;\n", { retainDocument: true });
		expect(generation?.diagnostics).toEqual([
			expect.objectContaining({ code: "PARSER_SYNTAX_ERROR", path: "broken.ts" }),
		]);
		expect(result.metadata).toMatchObject({ freshness: "partially_stale", diagnosticCount: 1 });
	});

	it("retries transient parser diagnostics instead of reusing the partial generation", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "a.ts"), "export const recovered = 1;\n");
		const first = await initializeRepoMap({ cwd: root }, dependencies({
			async indexSymbols(input) {
				return await indexRepoMapSymbols({
					...input,
					analyze(filePath, text, options) {
						return { ...analyzeCodeFile(filePath, text, options), status: "error", imports: [] };
					},
				});
			},
		}));
		const indexSymbols = vi.fn(async (input: Parameters<typeof indexRepoMapSymbols>[0]) =>
			await indexRepoMapSymbols({ ...input, analyze: analyzeCodeFile }));

		const result = await initializeRepoMap({ cwd: root, mode: "refresh" }, dependencies({ indexSymbols }));

		expect(first.metadata).toMatchObject({ freshness: "partially_stale", diagnosticCount: 1, parseErrorFileCount: 1 });
		expect(indexSymbols).toHaveBeenCalledOnce();
		expect(result.metadata).toMatchObject({ freshness: "fresh", diagnosticCount: 0, parseErrorFileCount: 0, symbolCount: 1 });
		expect(result.metadata.generation).not.toBe(first.metadata.generation);
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

	it("serializes concurrent initialization for the same map before scanning", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(root, { recursive: true });
		const firstScan = deferred<void>();
		const release = deferred<void>();
		let scanCalls = 0;
		let activeScans = 0;
		let maximumActiveScans = 0;
		const scan: RepoMapServiceDependencies["scan"] = async () => {
			scanCalls += 1;
			activeScans += 1;
			maximumActiveScans = Math.max(maximumActiveScans, activeScans);
			if (scanCalls === 1) {
				firstScan.resolve(undefined);
				await release.promise;
			}
			activeScans -= 1;
			return {
				files: [],
				diagnostics: [],
				summary: {
					discovered: 0, indexed: 0, reused: 0, hashed: 0, added: 0, changed: 0, removed: 0,
					tooLarge: 0, unreadable: 0, unstable: 0, parsed: 0, unsupported: 0, parseErrors: 0,
					reusedParsed: 0, symbols: 0, testNodes: 0, edges: 0, skippedDirectories: 0, diagnostics: 0,
				},
			};
		};
		const deps = dependencies({ scan });
		const first = initializeRepoMap({ cwd: root }, deps);
		await firstScan.promise;
		const second = initializeRepoMap({ cwd: root }, deps);
		await Promise.resolve();
		expect(scanCalls).toBe(1);
		release.resolve(undefined);
		await Promise.all([first, second]);
		expect(scanCalls).toBe(2);
		expect(maximumActiveScans).toBe(1);
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let settle: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => { settle = resolve; });
	return {
		promise,
		resolve(value) {
			if (settle === undefined) throw new Error("Deferred promise was not initialized");
			settle(value);
		},
	};
}
