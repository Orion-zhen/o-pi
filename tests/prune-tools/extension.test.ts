import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import pruneToolsExtension, {
	applyPersistedToolPruning,
	runPruneToolsCommand,
	runPruneToolsCommandArgs,
	runRestorePruneToolsCommand,
	type PruneToolsCommandApi,
	type PruneToolsCommandContext,
} from "../../agent/extensions/prune-tools.js";
import {
	buildPruneCostPreview,
	findCompletedToolCallIds,
	findRestorablePruneToolsState,
	findVisibleToolCallIds,
	getLastUsage,
	getUsageContextTokens,
	PRUNE_TOOLS_STATE,
	PRUNE_TOOLS_STATE_VERSION,
	pruneToolTransactions,
	readPruneToolsState,
	type PruneToolsState,
} from "../../src/prune-tools/prune-tools.js";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("prune-tools", () => {
	it("只选择有对应 output 的完整工具事务", () => {
		const messages: AgentMessage[] = [
			user("inspect"),
			assistant([
				{ type: "toolCall", id: "done", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "pending", name: "read", arguments: { path: "b.ts" } },
			]),
			toolResult("done", "a"),
		];

		expect([...findCompletedToolCallIds(messages)]).toEqual(["done"]);
	});

	it("删除 call、对应 output 和 tool-only assistant，并保留文本与未完成调用", () => {
		const messages: AgentMessage[] = [
			user("inspect"),
			assistant([
				{ type: "thinking", thinking: "read a", thinkingSignature: "sig-a" },
				{ type: "toolCall", id: "a", name: "read", arguments: { path: "a.ts" } },
			]),
			toolResult("a", "a output"),
			assistant([
				{ type: "thinking", thinking: "explain and read b", thinkingSignature: "sig-b" },
				{ type: "text", text: "Checking another file." },
				{ type: "toolCall", id: "b", name: "read", arguments: { path: "b.ts" } },
			]),
			toolResult("b", "b output"),
			assistant([
				{ type: "thinking", thinking: "parallel reads", thinkingSignature: "sig-c" },
				{ type: "toolCall", id: "c", name: "read", arguments: { path: "c.ts" } },
				{ type: "toolCall", id: "pending", name: "read", arguments: { path: "pending.ts" } },
			]),
			toolResult("c", "c output"),
		];

		const result = pruneToolTransactions(messages, new Set(["a", "b", "c"]));
		expect(result).toMatchObject({
			removedAssistantMessages: 1,
			removedToolCalls: 3,
			removedToolResults: 3,
		});
		expect(result.messages).toHaveLength(3);
		expect(result.messages[1]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Checking another file." }],
		});
		expect(result.messages[2]).toMatchObject({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "parallel reads" },
				{ type: "toolCall", id: "pending" },
			],
		});
	});

	it("usage totalTokens 为 0 时回退到分项 token", () => {
		const usage: Usage = {
			...ZERO_USAGE,
			input: 100,
			output: 20,
			cacheRead: 300,
			cacheWrite: 4,
		};

		expect(getUsageContextTokens(usage)).toBe(424);
		expect(getLastUsage([assistant([], usage)])).toEqual(usage);
	});

	it("按当前会话样本的价格判断下一次请求保留缓存更便宜", () => {
		const preview = buildPruneCostPreview({
			model: solModel(),
			fullTokens: 230_255,
			prunedTokens: 40_582,
			commonPrefixTokens: 2_300,
			cacheableFullTokens: 229_233,
			usesCacheWrite: false,
		});

		expect(preview.keepCostUsd).toBeCloseTo(0.1197265);
		expect(preview.pruneCostUsd).toBeCloseTo(0.19256);
		expect(preview.shouldPrune).toBe(false);
		expect(preview.missPricing).toBe("input");
	});

	it("低置信度估算取消 10% 宽松条件", () => {
		const input = {
			model: solModel(),
			fullTokens: 100_000,
			prunedTokens: 99_000,
			commonPrefixTokens: 97_000,
			cacheableFullTokens: 99_000,
			usesCacheWrite: true,
		};

		const highConfidence = buildPruneCostPreview(input);
		const lowConfidence = buildPruneCostPreview({ ...input, tokenConfidence: "low" });

		expect(highConfidence.pruneCostUsd).toBeGreaterThan(highConfidence.keepCostUsd);
		expect(highConfidence.pruneCostUsd).toBeLessThanOrEqual(highConfidence.keepCostUsd * 1.1);
		expect(highConfidence.shouldPrune).toBe(true);
		expect(lowConfidence.closeRatio).toBe(0);
		expect(lowConfidence.tokenConfidence).toBe("low");
		expect(lowConfidence.shouldPrune).toBe(false);
	});

	it("裁剪成本更低或在 10% 内时执行，并按请求总输入选择价格档", () => {
		const lower = buildPruneCostPreview({
			model: solModel(),
			fullTokens: 100_000,
			prunedTokens: 10_000,
			commonPrefixTokens: 2_000,
			cacheableFullTokens: 100_000,
			usesCacheWrite: false,
		});
		const tiered = buildPruneCostPreview({
			model: solModel({ inputTokensAbove: 50_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }),
			fullTokens: 100_000,
			prunedTokens: 10_000,
			commonPrefixTokens: 0,
			cacheableFullTokens: 100_000,
			usesCacheWrite: true,
		});

		expect(lower.shouldPrune).toBe(true);
		expect(lower.pruneCostUsd).toBeLessThan(lower.keepCostUsd);
		expect(tiered.keepCostUsd).toBeCloseTo(0.1);
		expect(tiered.pruneCostUsd).toBeCloseTo(0.0625);
		expect(tiered.missPricing).toBe("cache_write");
		expect(tiered.shouldPrune).toBe(true);
	});

	it("只从当前 branch 恢复最后一个合法持久化状态", () => {
		const state = pruneState(["a", "a", "b"]);
		const entries: SessionEntry[] = [
			customEntry("other", {}),
			customEntry(PRUNE_TOOLS_STATE, { version: 3 }),
			customEntry(PRUNE_TOOLS_STATE, state),
		];

		expect(readPruneToolsState(entries)).toEqual({ ...state, toolCallIds: ["a", "b"] });
		expect(readPruneToolsState([customEntry(PRUNE_TOOLS_STATE, { version: 1, toolCallIds: [1] })])).toBeUndefined();
	});

	it("兼容 v1 状态，并找到最近一次尚未撤销的裁剪", () => {
		const first = customEntry(PRUNE_TOOLS_STATE, { version: 1, toolCallIds: ["a"] }, "prune-1");
		const second = customEntry(PRUNE_TOOLS_STATE, pruneState(["a", "b"], ["a"]), "prune-2");
		const restoreSecond = customEntry(PRUNE_TOOLS_STATE, restoreState(["a"], "prune-2"), "restore-2");
		const entries = [first, second, restoreSecond];

		expect(readPruneToolsState([first])).toEqual(pruneState(["a"]));
		expect(readPruneToolsState(entries)).toEqual(restoreState(["a"], "prune-2"));
		expect(findRestorablePruneToolsState(entries)).toEqual({
			...pruneState(["a"]),
			entryId: "prune-1",
		});
	});

	it("注册 /prune-tools 与 context hook", () => {
		const registrations = captureRegistrations();
		expect(registrations.commands).toEqual(["prune-tools"]);
		expect(registrations.events).toContain("context");
	});

	it("持久化状态只裁剪激活时记录的 call，保留后续新事务", () => {
		const messages: AgentMessage[] = [
			assistant([{ type: "toolCall", id: "old", name: "read", arguments: {} }]),
			toolResult("old", "old output"),
			assistant([{ type: "toolCall", id: "new", name: "read", arguments: {} }]),
			toolResult("new", "new output"),
		];
		const entries = [customEntry(PRUNE_TOOLS_STATE, pruneState(["old"]))];

		const pruned = applyPersistedToolPruning(messages, entries);

		expect(pruned).toHaveLength(2);
		expect(pruned[0]).toMatchObject({ role: "assistant", content: [{ type: "toolCall", id: "new" }] });
		expect(pruned[1]).toMatchObject({ role: "toolResult", toolCallId: "new" });
	});

	it("只把有效上下文中完整存在的 tool transaction 视为可见", () => {
		const messages: AgentMessage[] = [
			assistant([{ type: "toolCall", id: "old", name: "skill", arguments: { name: "demo" } }]),
			toolResult("old", "old skill body"),
			assistant([{ type: "toolCall", id: "new", name: "skill", arguments: { name: "demo" } }]),
			toolResult("new", "new skill body"),
		];
		const entries = [customEntry(PRUNE_TOOLS_STATE, pruneState(["old"]))];

		expect(findVisibleToolCallIds(messages, entries)).toEqual(new Set(["new"]));
	});

	it("命令在下一次请求更便宜时持久化裁剪状态", async () => {
		const entries = transactionEntries();
		const appended: Array<{ customType: string; data: unknown }> = [];
		const notices: string[] = [];
		const api: PruneToolsCommandApi = {
			appendEntry(customType, data) {
				appended.push({ customType, data });
			},
			getActiveTools: () => [],
			getAllTools: () => [],
		};
		const context: PruneToolsCommandContext = {
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

		await runPruneToolsCommand(api, context);

		expect(appended).toHaveLength(1);
		expect(appended[0]).toMatchObject({
			customType: PRUNE_TOOLS_STATE,
			data: {
				version: PRUNE_TOOLS_STATE_VERSION,
				operation: "prune",
				toolCallIds: ["done"],
				previousToolCallIds: [],
			},
		});
	});

	it("成本基线使用有效上下文而不是原始 context usage", async () => {
		const entries = transactionEntries();
		const appended: unknown[] = [];
		const notices: string[] = [];
		const api: PruneToolsCommandApi = {
			appendEntry(_customType, data) {
				appended.push(data);
			},
			getActiveTools: () => [],
			getAllTools: () => [],
		};
		const context: PruneToolsCommandContext = {
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

		await runPruneToolsCommand(api, context);

		expect(appended).toHaveLength(1);
		expect(notices[0]).toContain("Next prompt:");
		expect(notices[0]).not.toContain("10k ->");
	});

	it("force 跳过模型与成本计算并持久化可撤销的裁剪状态", async () => {
		const entries = transactionEntries();
		const appended: Array<{ customType: string; data: unknown }> = [];
		const notices: string[] = [];
		const api: PruneToolsCommandApi = {
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
		const context: PruneToolsCommandContext = {
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

		await runPruneToolsCommandArgs(api, context, " FORCE ");

		expect(appended).toEqual([{
			customType: PRUNE_TOOLS_STATE,
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
			customEntry(PRUNE_TOOLS_STATE, pruneState(["a"]), "prune-1"),
			customEntry(PRUNE_TOOLS_STATE, pruneState(["a", "b"], ["a"]), "prune-2"),
		];
		const appended: Array<{ customType: string; data: unknown }> = [];
		const notices: string[] = [];

		await runRestorePruneToolsCommand(
			{
				appendEntry(customType, data) {
					appended.push({ customType, data });
				},
			},
			{
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
			customType: PRUNE_TOOLS_STATE,
			data: restoreState(["a"], "prune-2"),
		}]);
		expect(notices[0]).toContain("1 tool calls returned");
	});

	it("compaction 移除部分事务时不追加部分 restore 状态", async () => {
		const entries = [
			messageEntry("assistant-a", assistant([{ type: "toolCall", id: "a", name: "read", arguments: {} }])),
			messageEntry("result-a", toolResult("a", "a output")),
			customEntry(PRUNE_TOOLS_STATE, pruneState(["a", "b"]), "prune-1"),
		];
		const appended: unknown[] = [];
		const notices: string[] = [];

		await runRestorePruneToolsCommand(
			{
				appendEntry(_customType, data) {
					appended.push(data);
				},
			},
			{
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
		expect(notices[0]).toContain("compaction removed");
		expect(notices[0]).toContain("No restore state was written");
	});

	it("没有可撤销裁剪时不写状态", async () => {
		const entries = [
			customEntry(PRUNE_TOOLS_STATE, pruneState(["a"]), "prune-1"),
			customEntry(PRUNE_TOOLS_STATE, restoreState([], "prune-1"), "restore-1"),
		];
		const appended: unknown[] = [];
		const notices: string[] = [];

		await runRestorePruneToolsCommand(
			{
				appendEntry(_customType, data) {
					appended.push(data);
				},
			},
			{
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
		expect(notices).toEqual(["No /prune-tools change to restore."]);
	});
});

function user(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistant(content: AssistantMessage["content"], usage: Usage = ZERO_USAGE): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		usage,
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	};
}

function solModel(tier?: { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }): Model<Api> {
	return {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 5,
			output: 30,
			cacheRead: 0.5,
			cacheWrite: 6.25,
			...(tier ? { tiers: [tier] } : {}),
		},
		contextWindow: 272_000,
		maxTokens: 128_000,
	};
}

function pruneState(toolCallIds: string[], previousToolCallIds: string[] = []): PruneToolsState {
	return {
		version: PRUNE_TOOLS_STATE_VERSION,
		operation: "prune",
		toolCallIds,
		previousToolCallIds,
	};
}

function restoreState(toolCallIds: string[], restoredEntryId: string): PruneToolsState {
	return {
		version: PRUNE_TOOLS_STATE_VERSION,
		operation: "restore",
		toolCallIds,
		restoredEntryId,
	};
}

function customEntry(customType: string, data: unknown, id = `${customType}-${JSON.stringify(data).length}`): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-07-23T00:00:00.000Z",
		customType,
		data,
	};
}

function transactionEntries(): SessionEntry[] {
	const cachedUsage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 10_000,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0.005, cacheWrite: 0, total: 0.005 },
	};
	return [
		messageEntry("user", user("inspect")),
		messageEntry("assistant", assistant(
			[{ type: "toolCall", id: "done", name: "read", arguments: { path: "a.ts" } }],
			cachedUsage,
		)),
		messageEntry("result", toolResult("done", "large output ".repeat(100))),
	];
}

function messageEntry(id: string, message: AgentMessage): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-07-23T00:00:00.000Z",
		message,
	};
}

function captureRegistrations(): { commands: string[]; events: string[] } {
	const commands: string[] = [];
	const events: string[] = [];
	const api: Pick<ExtensionAPI, "appendEntry" | "getActiveTools" | "getAllTools" | "on" | "registerCommand"> = {
		appendEntry() {},
		getActiveTools: () => [],
		getAllTools: () => [],
		on(event) {
			events.push(event);
		},
		registerCommand(name) {
			commands.push(name);
		},
	};
	pruneToolsExtension(api);
	return { commands, events };
}
