import { createRequire } from "node:module";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { REPO_MAP_SESSION_ENTRY } from "../../src/repo-map/activation.js";
import { registerRepoMapCommand, type RepoMapCommandDependencies } from "../../src/repo-map/commands.js";
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
	it("registers only /init, appends activation after success, and avoids duplicate activation", async () => {
		const harness = commandHarness();
		expect(harness.registered.map(([name]) => name)).toEqual(["init"]);
		await harness.handler("", harness.ctx);
		expect(harness.appended).toHaveLength(1);
		expect(harness.appended[0]).toMatchObject({ customType: REPO_MAP_SESSION_ENTRY, data: { kind: "activation", mapId: "a".repeat(64) } });
		await harness.handler("", harness.ctx);
		expect(harness.appended).toHaveLength(1);
		expect(harness.initialize).toHaveBeenCalledTimes(2);
		expect(harness.status.at(-1)).toEqual(["repo-map", undefined]);
		expect(harness.notifications.at(-1)?.[0]).toContain("Repo Map active");
	});

	it("does not append on failure or cancellation", async () => {
		for (const failure of [new RepoMapError("CONFIG_ERROR", "bad config"), new RepoMapError("OPERATION_ABORTED", "cancelled")]) {
			const harness = commandHarness({ initialize: vi.fn(async () => { throw failure; }) });
			await harness.handler("", harness.ctx);
			expect(harness.appended).toEqual([]);
			expect(harness.notifications.at(-1)?.[0]).toBe(failure.message);
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

	it("shows active metadata or unavailable for the exact activation", async () => {
		const active = commandHarness();
		await active.handler("", active.ctx);
		await active.handler("status", active.ctx);
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
		signal: undefined,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify(message: string, type?: string) { notifications.push([message, type]); },
			setStatus(key: string, text: string | undefined) { status.push([key, text]); },
		},
	} as ExtensionCommandContext;
	return { handler: command[1].handler, ctx, appended, registered, notifications, status, initialize, readActivated };
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
