import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	applyPersistedToolPruning,
	findCompletedToolCallIds,
	findRestorablePruneState,
	findVisibleToolCallIds,
	PRUNE_STATE,
	pruneToolTransactions,
	readPruneState,
} from "../../src/prune/prune.js";
import {
	assistant,
	customEntry,
	pruneState,
	restoreState,
	toolResult,
	user,
} from "./fixtures.js";

describe("prune context projection", () => {
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

	it("只接受合法的 prune 状态", () => {
		const state = pruneState(["a", "a", "b"]);
		const entries: SessionEntry[] = [
			customEntry("other", {}),
			customEntry(PRUNE_STATE, { operation: "prune", toolCallIds: ["ignored"] }),
			customEntry(PRUNE_STATE, state),
		];

		expect(readPruneState(entries)).toEqual({ ...state, toolCallIds: ["a", "b"] });
		expect(readPruneState([
			customEntry(PRUNE_STATE, { operation: "prune", toolCallIds: [1], previousToolCallIds: [] }),
		])).toBeUndefined();
	});

	it("找到最近一次尚未撤销的裁剪", () => {
		const first = customEntry(PRUNE_STATE, pruneState(["a"]), "prune-1");
		const second = customEntry(PRUNE_STATE, pruneState(["a", "b"], ["a"]), "prune-2");
		const restoreSecond = customEntry(PRUNE_STATE, restoreState(["a"], "prune-2"), "restore-2");
		const entries = [first, second, restoreSecond];

		expect(readPruneState(entries)).toEqual(restoreState(["a"], "prune-2"));
		expect(findRestorablePruneState(entries)).toEqual({
			...pruneState(["a"]),
			entryId: "prune-1",
		});
	});

	it("持久化状态只裁剪激活时记录的 call，保留后续新事务", () => {
		const messages: AgentMessage[] = [
			assistant([{ type: "toolCall", id: "old", name: "read", arguments: {} }]),
			toolResult("old", "old output"),
			assistant([{ type: "toolCall", id: "new", name: "read", arguments: {} }]),
			toolResult("new", "new output"),
		];
		const entries = [customEntry(PRUNE_STATE, pruneState(["old"]))];

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
		const entries = [customEntry(PRUNE_STATE, pruneState(["old"]))];

		expect(findVisibleToolCallIds(messages, entries)).toEqual(new Set(["new"]));
	});
});
