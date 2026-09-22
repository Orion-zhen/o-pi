import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { cleanupForkExecutionContext, createForkExecutionContext } from "../../../src/harness/subagent/session-context.ts";
import { useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("opi-fork-context-");
const model: Model<"openai-completions"> = {
	id: "test", name: "test", provider: "test", api: "openai-completions", baseUrl: "http://localhost/v1",
	reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("fork 模型上下文", () => {
	it.each([false, true])("保留删除和替换记录，SDK 恢复后与父上下文一致（压缩：%s）", async (compact) => {
		const manager = SessionManager.inMemory(temp.path);
		manager.appendMessage({ role: "system", content: "instructions", timestamp: 0 });
		const first = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		const omitted = manager.appendMessage({ role: "user", content: "omitted", timestamp: 2 });
		if (compact) manager.appendCompaction("summary", first, 100);
		manager.appendContextEdit(first, { content: "replacement" });
		manager.appendContextEdit(omitted, null);
		const original = structuredClone(manager.getEntries());
		const expected = manager.buildSessionContext().messages;
		const fork = await createForkExecutionContext({
			invocation: "command", cwd: temp.path, currentModel: model, activeTools: [], allTools: [],
			thinkingLevel: "off", systemPrompt: "instructions", sessionManager: manager,
		});
		try {
			const child = SessionManager.open(fork.snapshotPath);
			expect(child.buildSessionContext().messages).toEqual(expected);
			expect(child.getEntries().filter((entry) => entry.type === "context_edit")).toHaveLength(2);
			expect(manager.getEntries()).toEqual(original);
		} finally { await cleanupForkExecutionContext(fork); }
	});

	it("工具 fork 只继承当前调用之前的编辑，不带入当前批次或其他分支", async () => {
		const manager = SessionManager.inMemory(temp.path);
		const question = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		manager.appendContextEdit(question, { content: "another branch" });
		manager.branch(question);
		manager.appendContextEdit(question, { content: "selected branch" });
		const expected = manager.buildSessionContext().messages;
		manager.appendMessage({
			role: "assistant", content: [{ type: "toolCall", id: "fork-call", name: "subagent", arguments: {} }],
			api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 2,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		});
		const fork = await createForkExecutionContext({
			invocation: "tool", toolCallId: "fork-call", cwd: temp.path, currentModel: model,
			activeTools: [], allTools: [], thinkingLevel: "off", systemPrompt: "instructions", sessionManager: manager,
		});
		try {
			expect(SessionManager.open(fork.snapshotPath).buildSessionContext().messages).toEqual(expected);
		} finally { await cleanupForkExecutionContext(fork); }
	});
});
