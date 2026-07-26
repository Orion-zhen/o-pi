import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";

import pruneExtension, {
	runPruneCommand,
	runPruneCommandArgs,
	runRestorePruneCommand,
	type PruneCommandApi,
	type PruneCommandContext,
} from "../../agent/extensions/prune.js";
import { PRUNE_STATE } from "../../src/prune/prune.js";
import { getPruneTuiState, resetPruneTuiState, syncPruneTuiState } from "../../src/prune/tui-state.js";
import {
	assistant,
	customEntry,
	messageEntry,
	pruneState,
	restoreState,
	solModel,
	toolResult,
	transactionEntries,
} from "./fixtures.js";

beforeEach(() => {
	resetPruneTuiState();
});

describe("prune extension", () => {
	it("只注册 /prune，并保留 force 与 restore 补全", async () => {
		const registrations = captureRegistrations();
		expect(registrations.commands).toEqual(["prune"]);
		expect(registrations.entryRenderers).toEqual([PRUNE_STATE]);
		expect(registrations.events).toEqual(expect.arrayContaining([
			"context",
			"session_start",
			"session_tree",
			"session_shutdown",
		]));
		const complete = registrations.commandOptions[0]?.getArgumentCompletions;
		expect(complete).toBeTypeOf("function");
		if (!complete) throw new Error("missing prune argument completions");
		expect(await complete("f")).toEqual([{ label: "force", value: "force" }]);
		expect(await complete(" REST ")).toEqual([{ label: "restore", value: "restore" }]);
		expect(await complete("invalid")).toBeNull();
	});

	it("命令在下一次请求更便宜时持久化裁剪状态", async () => {
		const entries = transactionEntries();
		const appended: Array<{ customType: string; data: unknown }> = [];
		const notices: string[] = [];
		const api: PruneCommandApi = {
			appendEntry(customType, data) {
				appended.push({ customType, data });
				entries.push(customEntry(customType, data, "prune-appended"));
			},
			getActiveTools: () => [],
			getAllTools: () => [],
		};
		const context: PruneCommandContext = {
			mode: "tui",
			model: { ...solModel(), cost: { input: 0.5, output: 30, cacheRead: 0.5, cacheWrite: 0.5 } },
			sessionManager: {
				buildContextEntries: () => entries,
				getBranch: () => entries,
			},
			ui: {
				notify(message) {
					notices.push(message);
				},
			},
			waitForIdle: async () => {},
			getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
			getSystemPrompt: () => "",
		};

		await runPruneCommand(api, context);

		expect(appended).toHaveLength(1);
		expect(appended[0]).toMatchObject({
			customType: PRUNE_STATE,
			data: {
				operation: "prune",
				toolCallIds: ["done"],
				previousToolCallIds: [],
			},
		});
		expect(getPruneTuiState()).toMatchObject({
			latestCheckpointEntryId: "prune-appended",
			hiddenToolCalls: 1,
		});
	});

	it("成本基线使用有效上下文而不是原始 context usage", async () => {
		const entries = transactionEntries();
		const appended: unknown[] = [];
		const notices: string[] = [];
		const api: PruneCommandApi = {
			appendEntry(_customType, data) {
				appended.push(data);
			},
			getActiveTools: () => [],
			getAllTools: () => [],
		};
		const context: PruneCommandContext = {
			mode: "rpc",
			model: solModel(),
			sessionManager: {
				buildContextEntries: () => entries,
				getBranch: () => entries,
			},
			ui: {
				notify(message) {
					notices.push(message);
				},
			},
			waitForIdle: async () => {},
			getContextUsage: () => ({ tokens: 10_000, contextWindow: 272_000, percent: 3.7 }),
			getSystemPrompt: () => "",
		};

		await runPruneCommand(api, context);

		expect(appended).toHaveLength(1);
		expect(notices[0]).toContain("Next prompt:");
		expect(notices[0]).not.toContain("10k ->");
	});

	it("force 跳过模型与成本计算并持久化可撤销的裁剪状态", async () => {
		const entries = transactionEntries();
		const appended: Array<{ customType: string; data: unknown }> = [];
		const notices: string[] = [];
		const api: PruneCommandApi = {
			appendEntry(customType, data) {
				appended.push({ customType, data });
			},
			getActiveTools() {
				throw new Error("force must not inspect active tools");
			},
			getAllTools() {
				throw new Error("force must not inspect tool definitions");
			},
		};
		const context: PruneCommandContext = {
			mode: "rpc",
			model: undefined,
			sessionManager: {
				buildContextEntries: () => entries,
				getBranch: () => entries,
			},
			ui: {
				notify(message) {
					notices.push(message);
				},
			},
			waitForIdle: async () => {},
			getContextUsage() {
				throw new Error("force must not inspect context usage");
			},
			getSystemPrompt() {
				throw new Error("force must not inspect the system prompt");
			},
		};

		await runPruneCommandArgs(api, context, " FORCE ");

		expect(appended).toEqual([{
			customType: PRUNE_STATE,
			data: pruneState(["done"]),
		}]);
		expect(notices[0]).toContain("Force-pruned 1 calls");
		expect(notices[0]).toContain("Cost calculation was skipped.");
	});

	it("restore 撤销最近一次未撤销的成功裁剪", async () => {
		const entries = [
			messageEntry("assistant-a", assistant([{ type: "toolCall", id: "a", name: "read", arguments: {} }])),
			messageEntry("result-a", toolResult("a", "a output")),
			messageEntry("assistant-b", assistant([{ type: "toolCall", id: "b", name: "read", arguments: {} }])),
			messageEntry("result-b", toolResult("b", "b output")),
			customEntry(PRUNE_STATE, pruneState(["a"]), "prune-1"),
			customEntry(PRUNE_STATE, pruneState(["a", "b"], ["a"]), "prune-2"),
		];
		const appended: Array<{ customType: string; data: unknown }> = [];
		const notices: string[] = [];

		await runRestorePruneCommand(
			{
				appendEntry(customType, data) {
					appended.push({ customType, data });
					entries.push(customEntry(customType, data, "restore-appended"));
				},
			},
			{
				mode: "tui",
				sessionManager: {
					buildContextEntries: () => entries,
					getBranch: () => entries,
				},
				ui: {
					notify(message) {
						notices.push(message);
					},
				},
				waitForIdle: async () => {},
			},
		);

		expect(appended).toEqual([{
			customType: PRUNE_STATE,
			data: restoreState(["a"], "prune-2"),
		}]);
		expect(notices[0]).toContain("1 tool calls returned");
		expect(getPruneTuiState()).toMatchObject({
			latestCheckpointEntryId: "restore-appended",
			operation: "restore",
			hiddenToolCalls: 1,
		});
	});

	it("compaction 移除部分事务时不追加部分 restore 状态", async () => {
		const entries = [
			messageEntry("assistant-a", assistant([{ type: "toolCall", id: "a", name: "read", arguments: {} }])),
			messageEntry("result-a", toolResult("a", "a output")),
			customEntry(PRUNE_STATE, pruneState(["a", "b"]), "prune-1"),
		];
		const appended: unknown[] = [];
		const notices: string[] = [];
		syncPruneTuiState(entries);

		await runRestorePruneCommand(
			{
				appendEntry(_customType, data) {
					appended.push(data);
				},
			},
			{
				mode: "tui",
				sessionManager: {
					buildContextEntries: () => entries,
					getBranch: () => entries,
				},
				ui: {
					notify(message) {
						notices.push(message);
					},
				},
				waitForIdle: async () => {},
			},
		);

		expect(appended).toEqual([]);
		expect(getPruneTuiState()).toMatchObject({
			latestCheckpointEntryId: "prune-1",
			hiddenToolCalls: 2,
		});
		expect(notices[0]).toContain("compaction removed");
		expect(notices[0]).toContain("No restore state was written");
	});

	it("没有可撤销裁剪时不写状态", async () => {
		const entries = [
			customEntry(PRUNE_STATE, pruneState(["a"]), "prune-1"),
			customEntry(PRUNE_STATE, restoreState([], "prune-1"), "restore-1"),
		];
		const appended: unknown[] = [];
		const notices: string[] = [];

		await runRestorePruneCommand(
			{
				appendEntry(_customType, data) {
					appended.push(data);
				},
			},
			{
				mode: "rpc",
				sessionManager: {
					buildContextEntries: () => entries,
					getBranch: () => entries,
				},
				ui: {
					notify(message) {
						notices.push(message);
					},
				},
				waitForIdle: async () => {},
			},
		);

		expect(appended).toEqual([]);
		expect(notices).toEqual(["No /prune change to restore."]);
	});
});

function captureRegistrations(): {
	commands: string[];
	commandOptions: Array<Parameters<ExtensionAPI["registerCommand"]>[1]>;
	entryRenderers: string[];
	events: string[];
} {
	const commands: string[] = [];
	const commandOptions: Array<Parameters<ExtensionAPI["registerCommand"]>[1]> = [];
	const entryRenderers: string[] = [];
	const events: string[] = [];
	const api: Pick<
		ExtensionAPI,
		"appendEntry" | "getActiveTools" | "getAllTools" | "on" | "registerCommand" | "registerEntryRenderer"
	> = {
		appendEntry() {},
		getActiveTools: () => [],
		getAllTools: () => [],
		on(event) {
			events.push(event);
		},
		registerCommand(name, options) {
			commands.push(name);
			commandOptions.push(options);
		},
		registerEntryRenderer(customType) {
			entryRenderers.push(customType);
		},
	};
	pruneExtension(api);
	return { commands, commandOptions, entryRenderers, events };
}
