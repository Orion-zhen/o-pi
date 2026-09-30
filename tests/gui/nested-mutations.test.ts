import { expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { GuiHistory } from "../../src/gui/host/history.ts";
import { GuiPayloads } from "../../src/gui/host/payloads.ts";
import { nestedMutation, NESTED_MUTATION_ENTRY } from "../../src/gui/host/nested-mutations.ts";
import { useTempDir } from "../helpers/lifecycle.ts";
import { assistant } from "./transcript-fixtures.ts";

const temp = useTempDir("opi-nested-mutations-");
const diff = "-1 old\n+1 new";
const parent = assistant([{ type: "toolCall", id: "code", name: "codemode", arguments: { code: "await tools.edit(...)" } }]);

function appendResult(manager: SessionManager, name = "edit") {
	return manager.appendMessage({
		role: "toolResult", toolCallId: "code", toolName: "codemode", content: [], isError: false, timestamp: 101,
		nestedCalls: { complete: true, calls: [{ id: "code/1", name, status: "ok", arguments: { path: "a.ts" } }] },
	});
}

it.each(["edit", "write"])("%s 的真实 diff 落盘恢复，不进入模型上下文", (name) => {
	const manager = SessionManager.create(temp.path, temp.path);
	manager.appendMessage(parent);
	const data = nestedMutation("code", "code/1", name, { content: [], details: { diff } });
	expect(data).toBeDefined();
	manager.appendCustomEntry(NESTED_MUTATION_ENTRY, data);
	appendResult(manager, name);
	const file = manager.getSessionFile();
	if (!file) throw new Error("缺少会话文件");
	const restored = SessionManager.open(file);
	const history = new GuiHistory(new GuiPayloads()).project(restored);
	const result = history.entries.flatMap((entry) => entry.messages).find((message) => message.role === "toolResult");
	expect(result).toMatchObject({ nestedCalls: { calls: [{ output: { kind: "inline", value: { details: { diff } } } }] } });
	expect(JSON.stringify(restored.buildSessionContext().messages)).not.toContain(diff);
});

it("切换分支不会把另一分支的同名调用 diff 带入结果", () => {
	const manager = SessionManager.inMemory();
	const root = manager.appendMessage(parent);
	manager.appendCustomEntry(NESTED_MUTATION_ENTRY, nestedMutation("code", "code/1", "edit", { content: [], details: { diff } }));
	const first = appendResult(manager);
	manager.branch(root);
	const second = appendResult(manager);
	const history = new GuiHistory(new GuiPayloads()).project(manager);
	const result = (id: string) => history.entries.find((entry) => entry.id === id)?.messages[0];
	expect(result(first)).toMatchObject({ nestedCalls: { calls: [{ output: { kind: "inline" } }] } });
	expect(result(second)).toMatchObject({ nestedCalls: { calls: [{ id: "code/1" }] } });
	expect(JSON.stringify(result(second))).not.toContain(diff);
});

it("大 diff 使用既有载荷引用，不塞入历史快照", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(parent);
	const large = "+ inserted line\n".repeat(10_000);
	manager.appendCustomEntry(NESTED_MUTATION_ENTRY, nestedMutation("code", "code/1", "write", { content: [], details: { diff: large } }));
	appendResult(manager, "write");
	const payloads = new GuiPayloads();
	const history = new GuiHistory(payloads).project(manager);
	const result = history.entries.flatMap((entry) => entry.messages).find((message) => message.role === "toolResult");
	const output = result?.role === "toolResult" ? result.nestedCalls?.calls[0]?.output : undefined;
	if (output?.kind !== "reference") throw new Error("缺少大 diff 引用");
	expect(payloads.toolOutput(output.id).details).toEqual({ diff: large });
	expect(JSON.stringify(history)).not.toContain(large);
});
