import { expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { GuiHistory } from "../../src/gui/host/projection/history.ts";
import { GuiStream } from "../../src/gui/host/projection/stream.ts";
import { payloadKey } from "../../src/gui/shared/messages/output.ts";
import { GuiLiveTools } from "../../src/gui/host/projection/live-tools.ts";
import { GuiPayloads } from "../../src/gui/host/projection/payloads.ts";

function start(id: string, name: string, args: unknown, parentToolCallId?: string) {
	return { type: "tool_execution_start" as const, toolCallId: id, toolName: name, args,
		...(parentToolCallId === undefined ? {} : { parentToolCallId }) };
}

it("脚本中的命令进度不改变旧快照，完成后保留耗时并清除进度", () => {
	const tools = new GuiLiveTools(new GuiPayloads());
	const args = { command: "bun test" };
	tools.accept(start("code", "codemode", { code: 'text(await tools.bash({command:"bun test"}));' }));
	tools.accept(start("code/1", "bash", args, "code"));
	const initial = tools.project();
	expect(tools.size).toBe(2);
	const partialResult = { content: [{ type: "text" as const, text: "运行中" }] };
	tools.accept({ type: "tool_execution_update", toolCallId: "code/1", toolName: "bash", parentToolCallId: "code", args, partialResult });
	const progress = tools.project();
	partialResult.content.push({ type: "text", text: "测试通过" });
	tools.accept({ type: "tool_execution_update", toolCallId: "code/1", toolName: "bash", parentToolCallId: "code", args, partialResult });
	expect(initial[0]?.nestedCalls?.calls[0]?.output).toBeUndefined();
	expect(progress[0]?.nestedCalls?.calls[0]?.output).toMatchObject({ value: { content: [{ text: "运行中" }] } });
	expect(tools.project()).toMatchObject([{ toolCallId: "code", output: undefined, nestedCalls: { calls: [
		{ id: "code/1", output: { value: { content: [{ text: "运行中" }, { text: "测试通过" }] } } },
	] } }]);
	tools.accept({ type: "tool_execution_end", toolCallId: "code/1", toolName: "bash", parentToolCallId: "code", result: partialResult, isError: false, durationMs: 12 });
	const finished = tools.project()[0]?.nestedCalls?.calls[0];
	expect(finished).toMatchObject({ status: "ok", durationMs: 12 });
	expect(finished?.output).toBeUndefined();
	expect(tools.size).toBe(2);
	tools.accept({ type: "tool_execution_end", toolCallId: "code", toolName: "codemode", result: partialResult, isError: false });
	expect(tools.project()).toMatchObject([{ toolCallId: "code", completion: { isError: false },
		nestedCalls: { calls: [{ id: "code/1", status: "ok", durationMs: 12 }] } }]);
	expect(tools.size).toBe(0);
	tools.settle("code");
	expect(tools.project()).toEqual([]);
});

it("并行工具从进度到完成再进入历史，大结果和图片保持可读取", () => {
	const payloads = new GuiPayloads();
	const tools = new GuiLiveTools(payloads);
	const stream = new GuiStream(payloads);
	const history = new GuiHistory(payloads);
	const manager = SessionManager.inMemory();
	const content: ToolResultMessage["content"] = [
		{ type: "text", text: "x".repeat(70_000) },
		{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
	];
	tools.accept(start("fast", "extension", {}));
	tools.accept(start("slow", "bash", {}));
	tools.accept({ type: "tool_execution_update", toolCallId: "fast", toolName: "extension", args: {}, partialResult: { content } });
	const progress = tools.project().find((tool) => tool.toolCallId === "fast")?.output;
	if (progress?.kind !== "reference") throw new Error("缺少进度引用");
	const running = tools.project();
	tools.accept({ type: "tool_execution_end", toolCallId: "fast", toolName: "extension", result: { content }, isError: false, durationMs: 12 });
	const completed = tools.project();
	const output = completed.find((tool) => tool.toolCallId === "fast")?.output;
	if (output?.kind !== "reference") throw new Error("缺少结果引用");
	expect(running.every((tool) => tool.completion === undefined)).toBe(true);
	expect(completed.find((tool) => tool.toolCallId === "fast")?.completion).toEqual({ isError: false, durationMs: 12 });
	expect(tools.size).toBe(1);
	expect(payloadKey(output.id)).toBe(payloadKey(progress.id));
	expect(payloads.toolOutput(progress.id)).toBe(payloads.toolOutput(output.id));

	tools.accept({ type: "tool_execution_end", toolCallId: "slow", toolName: "bash", result: { content: [] }, isError: false });
	expect(tools.size).toBe(0);
	const message: ToolResultMessage = { role: "toolResult", toolCallId: "fast", toolName: "extension", content, isError: false, durationMs: 12, timestamp: 1 };
	stream.start(message);
	const streaming = stream.project();
	if (streaming?.role !== "toolResult") throw new Error("缺少流式结果消息");
	expect(streaming.output).toBe(output);
	manager.appendMessage(message);
	stream.end();
	tools.settle("fast");
	expect(tools.project()).toMatchObject([{ toolCallId: "slow", completion: { isError: false } }]);
	expect(tools.size).toBe(0);

	const snapshot = history.project(manager);
	const recorded = snapshot.entries.flatMap((entry) => entry.messages).find((item) => item.role === "toolResult");
	expect(recorded?.output).toBe(output);
	const projectedContent = payloads.toolOutput(output.id).content;
	expect(projectedContent).toEqual([{ type: "text", text: "x".repeat(70_000) }, { type: "image", mimeType: "image/png", imageId: expect.any(String) }]);

	manager.appendMessage({ ...message, toolCallId: "slow", toolName: "bash", content: [] });
	tools.settle("slow");
	history.project(manager);
	expect(tools.project()).toEqual([]);

});

it("脚本编辑成功后提供真实 diff 供界面显示和历史持久化", () => {
	const tools = new GuiLiveTools(new GuiPayloads());
	const args = { path: "a.ts", edits: [{ old: "old", new: "new" }] };
	const diff = "-1 old\n+1 new";
	tools.accept(start("code", "codemode", { code: `await tools.edit(${JSON.stringify(args)});` }));
	tools.accept(start("code/1", "edit", args, "code"));
	const mutation = tools.accept({ type: "tool_execution_end", toolCallId: "code/1", toolName: "edit", parentToolCallId: "code", durationMs: 12,
		result: { content: [{ type: "text", text: "已修改" }], details: { diff } }, isError: false });
	expect(mutation).toEqual({ toolCallId: "code/1", toolName: "edit", diff });
	expect(tools.project()[0]?.nestedCalls).toMatchObject({ complete: false, calls: [{ id: "code/1", status: "ok", durationMs: 12,
		output: { kind: "inline", value: { details: { diff } } } }] });
});

it("脚本中的命令失败时保留错误输出，结果消息到达后释放调用", () => {
	const tools = new GuiLiveTools(new GuiPayloads());
	tools.accept(start("code", "codemode", { code: 'await tools.bash({command:"bun test"});' }));
	tools.accept(start("code/1", "bash", { command: "bun test" }, "code"));
	const result = { content: [{ type: "text" as const, text: "测试失败" }], details: { status: "exited", exit_code: 1 } };
	expect(tools.accept({ type: "tool_execution_end", toolCallId: "code/1", toolName: "bash", parentToolCallId: "code", result, isError: true, durationMs: 5 })).toBeUndefined();
	expect(tools.project()[0]?.nestedCalls?.calls[0]).toMatchObject({ status: "error", durationMs: 5,
		output: { kind: "inline", value: result } });
	tools.accept({ type: "tool_execution_end", toolCallId: "code", toolName: "codemode", result: { content: [{ type: "text", text: "Script failed" }] }, isError: true });
	expect(tools.project()).toMatchObject([{ completion: { isError: true }, nestedCalls: { calls: [{ status: "error" }] } }]);
	expect(tools.size).toBe(0);
	tools.settle("code");
	expect(tools.project()).toEqual([]);
});
