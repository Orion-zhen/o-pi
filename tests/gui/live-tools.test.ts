import { expect, it } from "vitest";
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
	tools.accept({ type: "tool_execution_end", toolCallId: "code", toolName: "codemode", result: partialResult, isError: false });
	expect(tools.project()).toEqual([]);
	expect(tools.size).toBe(0);
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

it("脚本中的命令失败时保留错误输出，父脚本结束后释放调用", () => {
	const tools = new GuiLiveTools(new GuiPayloads());
	tools.accept(start("code", "codemode", { code: 'await tools.bash({command:"bun test"});' }));
	tools.accept(start("code/1", "bash", { command: "bun test" }, "code"));
	const result = { content: [{ type: "text" as const, text: "测试失败" }], details: { status: "exited", exit_code: 1 } };
	expect(tools.accept({ type: "tool_execution_end", toolCallId: "code/1", toolName: "bash", parentToolCallId: "code", result, isError: true, durationMs: 5 })).toBeUndefined();
	expect(tools.project()[0]?.nestedCalls?.calls[0]).toMatchObject({ status: "error", durationMs: 5,
		output: { kind: "inline", value: result } });
	tools.accept({ type: "tool_execution_end", toolCallId: "code", toolName: "codemode", result: { content: [{ type: "text", text: "Script failed" }] }, isError: true });
	expect(tools.project()).toEqual([]);
	expect(tools.size).toBe(0);
});
