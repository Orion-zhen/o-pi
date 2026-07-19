import { createRequire } from "node:module";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { REPO_MAP_SESSION_ENTRY } from "../../src/repo-map/activation.js";
import {
	createRepoMapCommandDependencies,
	registerRepoMapAutoActivation,
	registerRepoMapCommand,
	type RepoMapCommandDependencies,
	type RepoMapCommandModuleImports,
} from "../../src/repo-map/commands.js";
import { RepoMapError } from "../../src/repo-map/errors.js";
import type { InitializeRepoMapResult } from "../../src/repo-map/service.js";
import type { RepoMapGeneration } from "../../src/repo-map/storage.js";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
const require = createRequire(import.meta.url);
const parserModules = [
	require.resolve("tree-sitter"),
	require.resolve("tree-sitter-javascript"),
	require.resolve("tree-sitter-typescript"),
	require.resolve("tree-sitter-python"),
	require.resolve("tree-sitter-go"),
	require.resolve("tree-sitter-rust"),
];

describe("/init command", () => {
	it("discovers and activates an existing map without rebuilding or duplicate entries", async () => {
		const starts: Array<(event: unknown, ctx: ExtensionContext) => Promise<void>> = [];
		const harness = commandHarness();
		const discover = vi.fn(async () => ({
			root: "/repo",
			mapId: "a".repeat(64),
			generation: "b".repeat(64),
			freshness: "fresh" as const,
			needsRefresh: false,
		}));
		const initialize = vi.fn(async () => initializeResult());
		registerRepoMapAutoActivation({
			on(_event, handler) { starts.push(handler); },
			appendEntry: harness.api.appendEntry,
		}, { discover, initialize, now: () => new Date("2026-07-17T00:00:00.000Z") });
		const start = starts[0];
		if (start === undefined) throw new Error("session_start was not registered");

		await start({}, harness.ctx);
		expect(harness.appended).toHaveLength(1);
		expect(harness.appended[0]).toMatchObject({ customType: REPO_MAP_SESSION_ENTRY, data: { kind: "activation" } });
		expect(harness.status.at(-1)).toEqual(["repo-map", "Repo Map: active"]);
		await start({}, harness.ctx);
		expect(harness.appended).toHaveLength(1);
		expect(initialize).not.toHaveBeenCalled();
	});

	it("refreshes a stale discovered map and honors explicit off", async () => {
		const starts: Array<(event: unknown, ctx: ExtensionContext) => Promise<void>> = [];
		const harness = commandHarness();
		const discover = vi.fn(async () => ({
			root: "/repo",
			mapId: "a".repeat(64),
			generation: "1".repeat(64),
			freshness: "fresh" as const,
			needsRefresh: true,
		}));
		const initialize = vi.fn(async () => initializeResult());
		registerRepoMapAutoActivation({
			on(_event, handler) { starts.push(handler); },
			appendEntry: harness.api.appendEntry,
		}, { discover, initialize, now: () => new Date("2026-07-17T00:00:00.000Z") });
		const start = starts[0];
		if (start === undefined) throw new Error("session_start was not registered");

		await start({}, harness.ctx);
		expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo", mode: "refresh" }));
		expect(harness.appended.at(-1)?.data).toMatchObject({ generation: "b".repeat(64) });
		await harness.handler("off", harness.ctx);
		discover.mockClear();
		await start({}, harness.ctx);
		expect(discover).not.toHaveBeenCalled();
		expect(harness.status.at(-1)).toEqual(["repo-map", "Repo Map: inactive"]);
	});

	it("registers only /init, appends activation after success, and avoids duplicate activation", async () => {
		const harness = commandHarness();
		expect(harness.registered.map(([name]) => name)).toEqual(["init"]);
		await harness.handler("", harness.ctx);
		expect(harness.appended).toHaveLength(1);
		expect(harness.appended[0]).toMatchObject({ customType: REPO_MAP_SESSION_ENTRY, data: { kind: "activation", mapId: "a".repeat(64) } });
		await harness.handler("", harness.ctx);
		expect(harness.appended).toHaveLength(1);
		expect(harness.initialize).toHaveBeenCalledTimes(2);
		expect(harness.status.at(-1)).toEqual(["repo-map", "Repo Map: active"]);
		expect(harness.notifications.at(-1)?.[0]).toContain("Repo Map active");
	});

	it("shows an immediate initialization status until work settles", async () => {
		const result = initializeResult();
		const pending = deferred<InitializeRepoMapResult>();
		const harness = commandHarness({ initialize: async () => await pending.promise });

		const running = harness.handler("rebuild", harness.ctx);
		expect(harness.status).toEqual([["repo-map", "Repo Map: preparing"]]);
		expect(harness.notifications).toEqual([]);

		pending.resolve(result);
		await running;
		expect(harness.status.at(-1)).toEqual(["repo-map", "Repo Map: active"]);
	});

	it("renders phase and sampled count progress without flooding the UI", async () => {
		const result = initializeResult();
		const harness = commandHarness({
			initialize: async (input) => {
				input.onProgress?.({ phase: "discovering" });
				input.onProgress?.({ phase: "hashing", completed: 1, total: 1_000 });
				input.onProgress?.({ phase: "hashing", completed: 2, total: 1_000 });
				input.onProgress?.({ phase: "hashing", completed: 10, total: 1_000 });
				input.onProgress?.({ phase: "hashing", completed: 1_000, total: 1_000 });
				return result;
			},
		});

		await harness.handler("refresh", harness.ctx);
		expect(harness.status).toEqual([
			["repo-map", "Repo Map: preparing"],
			["repo-map", "Repo Map: discovering"],
			["repo-map", "Repo Map: hashing 1/1000"],
			["repo-map", "Repo Map: hashing 10/1000"],
			["repo-map", "Repo Map: hashing 1000/1000"],
			["repo-map", "Repo Map: active"],
		]);
	});

	it("does not append on failure or cancellation", async () => {
		for (const failure of [new RepoMapError("CONFIG_ERROR", "bad config"), new RepoMapError("OPERATION_ABORTED", "cancelled")]) {
			const harness = commandHarness({ initialize: vi.fn(async () => { throw failure; }) });
			await harness.handler("", harness.ctx);
			expect(harness.appended).toEqual([]);
			expect(harness.notifications.at(-1)?.[0]).toBe(failure.message);
			expect(harness.status.at(-1)).toEqual(["repo-map", "Repo Map: inactive"]);
		}
	});

	it("switches activation when /init resolves another repository", async () => {
		const harness = commandHarness();
		await harness.handler("", harness.ctx);
		const other = initializeResult("/other", "e");
		harness.initialize.mockResolvedValueOnce(other);
		await harness.handler("", harness.ctx);
		expect(harness.appended).toHaveLength(2);
		expect(harness.appended.at(-1)?.data).toMatchObject({ kind: "activation", root: "/other", mapId: "e".repeat(64) });
	});

	it("inactive status does no repository or storage work", async () => {
		const harness = commandHarness();
		for (const modulePath of parserModules) expect(require.cache[modulePath]).toBeUndefined();
		await harness.handler("status", harness.ctx);
		await harness.handler("off", harness.ctx);
		expect(harness.notifications).toEqual([["Repo Map inactive", "info"], ["Repo Map inactive", "info"]]);
		expect(harness.initialize).not.toHaveBeenCalled();
		expect(harness.readActivated).not.toHaveBeenCalled();
		for (const modulePath of parserModules) expect(require.cache[modulePath]).toBeUndefined();
	});

	it("loads service only for active work and reuses the loaded module", async () => {
		const result = initializeResult();
		const loadCurrentPointer = vi.fn(async () => ({ isActivatedGenerationCurrent: async () => true }));
		const loadService = vi.fn(async () => ({
			initializeRepoMap: async () => result,
			readActivatedRepoMapState: async (): Promise<RepoMapGeneration> => generationFor(result),
		}));
		const dependencies = createRepoMapCommandDependencies({ currentPointer: loadCurrentPointer, service: loadService });
		const harness = commandHarness(dependencies);

		await harness.handler("status", harness.ctx);
		await harness.handler("off", harness.ctx);
		await harness.handler("unknown", harness.ctx);
		expect(loadService).not.toHaveBeenCalled();

		await harness.handler("", harness.ctx);
		await harness.handler("status", harness.ctx);
		expect(loadCurrentPointer).toHaveBeenCalledTimes(1);
		expect(loadService).toHaveBeenCalledTimes(1);
	});

	it("reports an unavailable activation without loading the service", async () => {
		const result = initializeResult();
		const loadCurrentPointer = vi.fn(async () => ({ isActivatedGenerationCurrent: async () => false }));
		const loadService = vi.fn(async () => ({
			initializeRepoMap: async () => result,
			readActivatedRepoMapState: async (): Promise<RepoMapGeneration> => generationFor(result),
		}));
		const dependencies = createRepoMapCommandDependencies({ currentPointer: loadCurrentPointer, service: loadService });
		const activation = {
			root: "/repo",
			mapId: "a".repeat(64),
			generation: "b".repeat(64),
			activatedAt: "2026-07-17T00:00:00.000Z",
		};

		expect(await dependencies.readActivated(activation)).toBeUndefined();
		expect(loadCurrentPointer).toHaveBeenCalledTimes(1);
		expect(loadService).not.toHaveBeenCalled();
	});

	it("coalesces concurrent service loads and retries a rejected import", async () => {
		const result = initializeResult();
		let fail = true;
		const loadCurrentPointer = vi.fn(async () => ({ isActivatedGenerationCurrent: async () => true }));
		const loadService = vi.fn<RepoMapCommandModuleImports["service"]>(async () => {
			if (fail) throw new Error("load failed");
			return {
				initializeRepoMap: async () => result,
				readActivatedRepoMapState: async (): Promise<RepoMapGeneration> => generationFor(result),
			};
		});
		const dependencies = createRepoMapCommandDependencies({ currentPointer: loadCurrentPointer, service: loadService });

		await expect(dependencies.initialize({ cwd: "/repo" })).rejects.toThrow("load failed");
		fail = false;
		const [initialized, generation] = await Promise.all([
			dependencies.initialize({ cwd: "/repo" }),
			dependencies.readActivated({
				root: "/repo",
				mapId: "a".repeat(64),
				generation: "b".repeat(64),
				activatedAt: "2026-07-17T00:00:00.000Z",
			}),
		]);
		expect(initialized).toBe(result);
		expect(generation?.metadata).toBe(result.metadata);
		expect(loadService).toHaveBeenCalledTimes(2);
	});

	it("shows active metadata or unavailable for the exact activation", async () => {
		const active = commandHarness();
		await active.handler("", active.ctx);
		active.status.length = 0;
		await active.handler("status", active.ctx);
		expect(active.status).toEqual([
			["repo-map", "Repo Map: checking status"],
			["repo-map", "Repo Map: active"],
		]);
		expect(active.notifications.at(-1)?.[0]).toContain("cache schema: 5");
		const missing = commandHarness({ readActivated: vi.fn(async () => undefined) });
		await missing.handler("", missing.ctx);
		await missing.handler("status", missing.ctx);
		expect(missing.notifications.at(-1)?.[0]).toContain("freshness: unavailable");
	});

	it("supports refresh/rebuild modes; off is idempotent and invalid args show usage", async () => {
		const harness = commandHarness();
		await harness.handler("", harness.ctx);
		harness.initialize.mockClear();
		await harness.handler("off", harness.ctx);
		expect(harness.appended.at(-1)?.data).toMatchObject({ kind: "deactivation" });
		const count = harness.appended.length;
		await harness.handler("off", harness.ctx);
		expect(harness.appended).toHaveLength(count);
		expect(harness.initialize).not.toHaveBeenCalled();
		expect(harness.readActivated).not.toHaveBeenCalled();
		await harness.handler("refresh", harness.ctx);
		expect(harness.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: "/repo", mode: "refresh" }));
		await harness.handler("rebuild", harness.ctx);
		expect(harness.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: "/repo", mode: "rebuild" }));
		await harness.handler("unknown", harness.ctx);
		expect(harness.notifications.at(-1)).toEqual([
			"usage: /init | /init status | /init refresh | /init rebuild | /init off",
			"warning",
		]);
	});
});

function commandHarness(overrides: Partial<RepoMapCommandDependencies> = {}) {
	const branch: SessionEntry[] = [];
	const appended: Array<{ customType: string; data: unknown }> = [];
	const registered: Array<[string, CommandOptions]> = [];
	const notifications: Array<[string, string | undefined]> = [];
	const status: Array<[string, string | undefined]> = [];
	const result = initializeResult();
	const initialize = "initialize" in overrides && overrides.initialize !== undefined ? vi.fn(overrides.initialize) : vi.fn(async () => result);
	const readActivated = "readActivated" in overrides && overrides.readActivated !== undefined
		? vi.fn(overrides.readActivated)
		: vi.fn(async (): Promise<RepoMapGeneration> => ({ metadata: result.metadata, files: [], symbols: [], tests: [], architecture: [], aliases: [], edges: [], diagnostics: [] }));
	const api: Pick<ExtensionAPI, "registerCommand" | "appendEntry"> = {
		registerCommand(name, options) { registered.push([name, options]); },
		appendEntry(customType, data) {
			appended.push({ customType, data });
			branch.push({ type: "custom", id: String(branch.length), parentId: null, timestamp: "t", customType, data });
		},
	};
	registerRepoMapCommand(api, { initialize, readActivated, now: overrides.now ?? (() => new Date("2026-07-17T00:00:00.000Z")) });
	const command = registered[0];
	if (command === undefined) throw new Error("/init was not registered");
	const ctx = {
		cwd: "/repo",
		mode: "tui",
		signal: undefined,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify(message: string, type?: string) { notifications.push([message, type]); },
			setStatus(key: string, text: string | undefined) { status.push([key, text]); },
		},
	} as ExtensionCommandContext;
	return { handler: command[1].handler, ctx, branch, api, appended, registered, notifications, status, initialize, readActivated };
}

function initializeResult(root = "/repo", mapCharacter = "a"): InitializeRepoMapResult {
	const metadata = {
		schemaVersion: 5,
		mapId: mapCharacter.repeat(64),
		repositoryRoot: root,
		worktreeRoot: root,
		gitCommonDir: `${root}/.git`,
		generation: "b".repeat(64),
		createdAt: "2026-07-17T00:00:00.000Z",
		updatedAt: "2026-07-17T00:00:00.000Z",
		freshness: "fresh" as const,
		fileCount: 0,
		indexedFileCount: 0,
		parsedFileCount: 0,
		unsupportedFileCount: 0,
		parseErrorFileCount: 0,
		symbolCount: 0,
		testNodeCount: 0,
		edgeCount: 0,
		aliasCount: 0,
		tooLargeFileCount: 0,
		diagnosticCount: 0,
		gitRevision: "c".repeat(40),
		configFingerprint: "d".repeat(64),
		ignoreFingerprint: "ignore",
		parserFingerprint: "format",
	};
	return {
		identity: { repositoryRoot: root, worktreeRoot: root, gitCommonDir: `${root}/.git`, headRevision: "c".repeat(40) },
		metadata,
		summary: {
			discovered: 0, indexed: 0, reused: 0, hashed: 0, added: 0, changed: 0, removed: 0, tooLarge: 0,
			unreadable: 0, unstable: 0, parsed: 0, unsupported: 0, parseErrors: 0, reusedParsed: 0, symbols: 0, testNodes: 0,
			edges: 0, skippedDirectories: 0, diagnostics: 0,
		},
		reusedGeneration: false,
	};
}

function generationFor(result: InitializeRepoMapResult): RepoMapGeneration {
	return { metadata: result.metadata, files: [], symbols: [], tests: [], architecture: [], aliases: [], edges: [], diagnostics: [] };
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
