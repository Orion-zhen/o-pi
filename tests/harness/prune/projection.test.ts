import { describe, expect, it } from "vitest";
import {
	applyPersistedToolPruning, findCompletedToolCallIds, findRestorablePruneState,
	findVisibleToolCallIds, PRUNE_STATE, pruneToolTransactions, readPruneState,
} from "../../../src/harness/prune/prune.ts";
import { assistant, customEntry, pruneState, restoreState, toolResult, user } from "./fixtures.ts";

const toolCall = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: `${id}.ts` } });
const thinking = (text: string) => ({ type: "thinking" as const, thinking: text, thinkingSignature: text });

describe("裁剪上下文", () => {
	it("只裁剪完整工具事务，保留正文与未完成调用", () => {
		const messages = [
			user("inspect"),
			assistant([thinking("read a"), toolCall("a")]), toolResult("a", "a output"),
			assistant([thinking("read b"), { type: "text" as const, text: "Checking another file." }, toolCall("b")]), toolResult("b", "b output"),
			assistant([thinking("parallel reads"), toolCall("c"), toolCall("pending")]), toolResult("c", "c output"),
		];
		const completed = findCompletedToolCallIds(messages);
		expect([...completed]).toEqual(["a", "b", "c"]);
		const result = pruneToolTransactions(messages, completed);
		expect(result).toMatchObject({ removedAssistantMessages: 1, removedToolCalls: 3, removedToolResults: 3 });
		expect(result.messages).toEqual([
			messages[0],
			assistant([{ type: "text", text: "Checking another file." }]),
			assistant([thinking("parallel reads"), toolCall("pending")]),
		]);
	});

	it("恢复最近一次未撤销的裁剪，非法历史不覆盖有效记录", () => {
		const first = customEntry(PRUNE_STATE, pruneState(["a", "a"]), "first");
		const second = customEntry(PRUNE_STATE, pruneState(["a", "b"], ["a"]), "second");
		const restored = customEntry(PRUNE_STATE, restoreState(["a"], "second"));
		expect(readPruneState([first])).toEqual(pruneState(["a"]));
		expect(findRestorablePruneState([first, second, restored])).toEqual({ ...pruneState(["a"]), entryId: "first" });
		expect(readPruneState([
			first, customEntry("other", {}), customEntry(PRUNE_STATE, { operation: "prune", toolCallIds: [1], previousToolCallIds: [] }),
		])).toEqual(pruneState(["a"]));
	});

	it("历史裁剪只作用于记录中的事务，后续新工具仍可见", () => {
		const messages = ["old", "new"].flatMap((id) => [assistant([toolCall(id)]), toolResult(id, `${id} output`)]);
		const entries = [customEntry(PRUNE_STATE, pruneState(["old"]))];
		expect(applyPersistedToolPruning(messages, entries)).toEqual(messages.slice(2));
		expect(findVisibleToolCallIds(messages, entries)).toEqual(new Set(["new"]));
	});
});
