import { createElement } from "react";
import { renderWithMemory } from "./render.ts";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolActivity, TranscriptSource, TranscriptItem } from "../../src/gui/ui/transcript-items.ts";
import { transcriptReplies } from "../../src/gui/ui/transcript-replies.ts";
import { ToolResult } from "../../src/gui/ui/tool-results.tsx";
import { ToolActivity as ToolActivityView } from "../../src/gui/ui/tool-activity.tsx";
import { ParameterValue } from "../../src/gui/ui/tool-parameters.tsx";
import { MarkdownText } from "../../src/gui/ui/content.tsx";

import { assistant, call, result, source } from "./transcript-fixtures.ts";

const transcriptItems = (source: TranscriptSource): TranscriptItem[] => transcriptReplies(source)
	.flatMap((row) => row.kind === "message" ? [row] : [...row.process, ...row.answer]);

describe("聊天活动投影", () => {
	it("参数生成、执行更新和完成沿用一个节点，不重复展示结果", () => {
		const message = assistant([call]);
		const preparing = transcriptItems(source({ streamingMessage: message, streaming: true }));
		const running = transcriptItems(source({ messages: [message], streaming: true, liveTools: [{ type: "tool_execution_update", toolCallId: call.id, toolName: "read", args: call.arguments, partialResult: { content: [{ type: "text", text: "partial" }] } }] }));
		const finished = transcriptItems(source({ messages: [message, result] }));
		expect(preparing).toHaveLength(1);
		expect(running).toHaveLength(1);
		expect(finished).toHaveLength(1);
		expect(preparing[0]).toMatchObject({ key: running[0]?.key, kind: "tool", tool: { state: "preparing" } });
		expect(running[0]).toMatchObject({ key: finished[0]?.key, kind: "tool", tool: { state: "running", output: { content: [{ text: "partial" }] } } });
		expect(finished[0]).toMatchObject({ kind: "tool", tool: { state: "completed", output: result } });
	});

	it("并行结果按调用 ID 关联，不改变说明文字和调用的原始顺序", () => {
		const second = { ...call, id: "read-2", arguments: { path: "other.ts" } };
		const items = transcriptItems(source({ messages: [
			assistant([{ type: "text", text: "检查两个文件" }, call, second]),
			{ ...result, toolCallId: second.id, content: [{ type: "text", text: "second" }] }, result,
			assistant([{ type: "text", text: "检查完成" }], "stop"),
		] }));
		expect(items.map((item) => item.kind)).toEqual(["text", "tool", "tool", "text"]);
		expect(items[1]).toMatchObject({ tool: { id: call.id, output: { content: [{ text: "file content" }] } } });
		expect(items[2]).toMatchObject({ tool: { id: second.id, output: { content: [{ text: "second" }] } } });
	});

	it("同批调用的部分结果返回后，剩余调用仍显示等待执行", () => {
		const second = { ...call, id: "read-2" };
		const items = transcriptItems(source({ messages: [assistant([call, second]), result], streaming: true }));
		expect(items[0]).toMatchObject({ tool: { state: "completed" } });
		expect(items[1]).toMatchObject({ tool: { state: "pending" } });
	});

	it("思考完成后保持节点，不展示隐藏思考或隐藏扩展消息", () => {
		const thinking = { type: "thinking", thinking: "检查组件边界" } as const;
		const active = transcriptItems(source({ streamingMessage: assistant([thinking]), streaming: true }));
		const completed = transcriptItems(source({ messages: [assistant([thinking, call])] }));
		expect(active[0]).toMatchObject({ key: completed[0]?.key, kind: "thinking", active: true });
		expect(completed[0]).toMatchObject({ active: false });
		expect(transcriptItems(source({ messages: [assistant([{ type: "thinking", thinking: "opaque", redacted: true }]), { role: "custom", customType: "internal", content: "hidden", display: false, timestamp: 1 }] }))).toEqual([]);
	});

	it("结果流式提交与历史缺少调用时仍各展示一次", () => {
		expect(transcriptItems(source({ messages: [assistant([call])], streamingMessage: result }))).toHaveLength(1);
		expect(transcriptItems(source({ messages: [result] }))).toMatchObject([{ kind: "tool", tool: { name: "read", state: "completed", output: result } }]);
	});

	it("区分失败、取消和无结果，不把未执行的历史标为成功", () => {
		const items = (message: AssistantMessage, output?: ToolResultMessage) => transcriptItems(source({ messages: output ? [message, output] : [message] }));
		expect(items(assistant([call]), { ...result, isError: true })[0]).toMatchObject({ tool: { state: "failed" } });
		expect(items(assistant([call], "aborted"))[0]).toMatchObject({ tool: { state: "stopped" } });
		expect(items(assistant([call]), { ...result, isError: true, details: { status: "aborted" } })[0]).toMatchObject({ tool: { state: "stopped" } });
		expect(items(assistant([call]))[0]).toMatchObject({ tool: { state: "unavailable" } });
	});
});

function renderResult(name: string, args: unknown, details: unknown, content: unknown = []) {
	const tool: ToolActivity = { id: "tool-1", name, args, state: "completed", output: { content, details } };
	return renderWithMemory(createElement(ToolResult, { tool }));
}

describe("工具语义呈现", () => {
	it("成功和失败都默认折叠，失败仍展示错误摘要", () => {
		const tool: ToolActivity = { id: "missing-file", name: "read", args: { path: "missing.ts" }, state: "failed", output: { content: [{ type: "text", text: "文件不存在" }], details: { error: { code: "NOT_FOUND", message: "文件不存在" } } } };
		const failed = renderWithMemory(createElement(ToolActivityView, { tool }));
		expect(failed).toContain('aria-expanded="false"');
		expect(parseHTML(failed).document.querySelector(".activity-error")?.textContent).toBe("文件不存在");
		const completed = renderWithMemory(createElement(ToolActivityView, { tool: { ...tool, id: call.id, args: call.arguments, state: "completed", output: result } }));
		expect(completed).toContain('aria-expanded="false"');
	});

	it("子代理保持自动展开模式，切回已完成任务时自动收起", () => {
		const memory = new Map<string, boolean | null>();
		const tool: ToolActivity = { id: "subagent-1", name: "subagent", args: { task: "检查项目" }, state: "running", output: undefined };
		const running = parseHTML(renderWithMemory(createElement(ToolActivityView, { tool }), memory)).document;
		expect(running.querySelector(".activity-summary")?.getAttribute("aria-expanded")).toBe("true");
		const completed = parseHTML(renderWithMemory(createElement(ToolActivityView, {
			tool: { ...tool, state: "completed", output: { content: [{ type: "text", text: "检查完成" }] } },
		}), memory)).document;
		expect(completed.querySelector(".activity-summary")?.getAttribute("aria-expanded")).toBe("false");
	});

	it("Shell 日志按纯文本显示，保留空格并转义 HTML", () => {
		const html = renderResult("bash", { command: "printf 'hello'" }, {}, [{ type: "text", text: "# not a heading\n  <script>alert(1)</script>\n\u001b[31merror\u001b[0m" }]);
		expect(html).toContain("# not a heading");
		expect(html).not.toContain("<h1");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("\u001b");
	});

	it("扩展参数按字段、列表和布尔值显示，字符串 payload 不重新解析", () => {
		const html = renderWithMemory(createElement(ParameterValue, { value: { path: "中文.ts", enabled: true, options: ["first", "second"], payload: '{"keep":"raw"}' } }));
		const doc = parseHTML(html).document;
		expect(doc.documentElement.textContent).toContain("中文.ts");
		expect(doc.documentElement.textContent).toContain('{"keep":"raw"}');
	});

	it("流式代码块从空围栏到正文均可渲染，未知语言作为文本而非 HTML", () => {
		const render = (text: string) => renderWithMemory(createElement(MarkdownText, { text }));
		expect(() => render("```ts\n")).not.toThrow();
		const html = render("```ts\nconst answer = 42;\n```\n\n```unknown-language\n<script>alert(1)</script>\n```");
		const doc = parseHTML(html).document;
		expect(doc.querySelector("pre")?.textContent).toContain("const answer = 42;");
		expect(doc.querySelector("script")).toBeNull();
		expect(html).toContain("&lt;script&gt;");
	});
});
