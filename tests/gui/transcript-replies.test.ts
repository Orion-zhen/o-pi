import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TextContent, UserMessage } from "@earendil-works/pi-ai";
import { transcriptReplies } from "../../src/gui/ui/transcript-replies.ts";
import { Transcript } from "../../src/gui/ui/transcript.tsx";
import { assistant, call, result, source } from "./transcript-fixtures.ts";

const user: UserMessage = { role: "user", content: "检查项目", timestamp: 1 };
const text = (value: string): TextContent => ({ type: "text", text: value });
const phase = (value: string, phase: "commentary" | "final_answer"): TextContent => ({
	...text(value), textSignature: JSON.stringify({ v: 1, id: `msg-${phase}`, phase }),
});
const thinking = { type: "thinking", thinking: "检查文件边界" } as const;
const replies = (value: ReturnType<typeof source>) => transcriptReplies(value).filter((row) => row.kind === "reply");

describe("整轮处理过程折叠", () => {
	it("多轮思考、工具和中途正文归入同一组，只保留最后报告", () => {
		const second = { ...call, id: "read-2" };
		const rows = replies(source({ messages: [user,
			assistant([text("先检查组件"), thinking, call]), result,
			assistant([thinking, text("接下来检查样式"), second]), { ...result, toolCallId: second.id },
			assistant([thinking, text("检查完成"), text("没有发现问题")], "stop"),
		] }));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ state: "completed", final: true, answer: [{ text: "检查完成" }, { text: "没有发现问题" }] });
		expect(rows[0]?.process.filter((item) => item.kind === "text").map((item) => item.text)).toEqual(["先检查组件", "接下来检查样式"]);
		expect(rows[0]?.process.filter((item) => item.kind === "tool")).toHaveLength(2);
		expect(rows[0]?.process.filter((item) => item.kind === "thinking")).toHaveLength(3);
	});

	it("阶段标记区分同一条消息中的 commentary 和 final_answer", () => {
		const reply = assistant([phase("已经找到原因", "commentary"), phase("最终报告", "final_answer")], "stop");
		const rows = replies(source({ messages: [user, reply] }));
		expect(rows[0]?.process).toMatchObject([{ kind: "text", text: "已经找到原因" }]);
		expect(rows[0]?.answer).toMatchObject([{ text: "最终报告" }]);
		expect(rows[0]?.final).toBe(true);
		const live = replies(source({ messages: [user], streamingMessage: reply, streaming: true }));
		expect(live[0]).toMatchObject({ state: "running", final: true });
	});

	it("没有阶段标记的正文先流式展示，不提前自动折叠", () => {
		const live = assistant([thinking, text("我先检查")], "pending");
		const streaming = replies(source({ messages: [user], streamingMessage: live, streaming: true }));
		expect(streaming[0]).toMatchObject({ final: false, answer: [{ text: "我先检查" }] });
		const calling = replies(source({ messages: [user], streamingMessage: assistant([...live.content, call]), streaming: true }));
		expect(calling[0]).toMatchObject({ key: streaming[0]?.key, final: false, answer: [] });
		expect(calling[0]?.process).toContainEqual(expect.objectContaining({ kind: "text", text: "我先检查" }));
		const completed = replies(source({ messages: [user, assistant([...live.content, call]), result, assistant([text("最终报告")], "stop")] }));
		expect(completed[0]).toMatchObject({ key: streaming[0]?.key, final: true, answer: [{ text: "最终报告" }] });
	});

	it("普通回复结束才确认最终正文，旧字符串签名仍能显示", () => {
		const reply = assistant([{ ...text("最终正文"), textSignature: "msg_legacy" }], "stop");
		expect(replies(source({ messages: [user], streamingMessage: reply, streaming: true }))[0]?.final).toBe(false);
		expect(replies(source({ messages: [user, reply], streaming: true }))[0]?.final).toBe(true);
	});

	it("每条用户消息独立分组，只有最后一组处于生成中", () => {
		const rows = replies(source({ messages: [user, assistant([text("第一份回复")], "stop"),
			{ ...user, content: "继续检查", timestamp: 2 }], streamingMessage: assistant([thinking], "pending"), streaming: true }));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ state: "completed", final: true });
		expect(rows[1]).toMatchObject({ state: "running", final: false, answer: [] });
		expect(rows[0]?.key).not.toBe(rows[1]?.key);
	});

	it.each(["aborted", "error", "length"] as const)("%s 时保留部分正文并明确标注状态，不冒充完成", (stopReason) => {
		const message = { ...assistant([thinking, text("已生成的部分")], stopReason), errorMessage: "任务没有正常完成" };
		const row = replies(source({ messages: [user, message] }))[0];
		expect(row).toMatchObject({ state: stopReason === "aborted" ? "stopped" : stopReason === "error" ? "failed" : "incomplete", final: false, answer: [{ text: "已生成的部分" }], error: "任务没有正常完成" });
		expect(row?.process.some((item) => item.kind === "error")).toBe(false);
	});

	it("重试期间不把失败的片段当最终回复，恢复后将旧错误归入过程", () => {
		const failed = { ...assistant([text("失败前的部分")], "error"), errorMessage: "暂时不可用" };
		const retrying = replies(source({ messages: [user, failed], retrying: true }));
		expect(retrying[0]).toMatchObject({ state: "running", retrying: true, final: false, answer: [] });
		const completed = replies(source({ messages: [user, failed, assistant([text("重试完成")], "stop")] }));
		expect(completed[0]).toMatchObject({ key: retrying[0]?.key, state: "completed", final: true, error: undefined });
		expect(completed[0]?.process).toContainEqual(expect.objectContaining({ kind: "error", text: "暂时不可用" }));
	});

	it("没有最终正文时不提升旧说明，孤立工具结果仍可查看", () => {
		const noFinal = replies(source({ messages: [user, assistant([text("开始检查"), call]), result, assistant([], "stop")] }));
		expect(noFinal[0]).toMatchObject({ state: "incomplete", final: false, answer: [] });
		const orphan = replies(source({ messages: [result] }));
		expect(orphan[0]?.process).toMatchObject([{ kind: "tool", tool: { output: result } }]);
	});

	it("仅有 commentary 的回复不会被标为最终报告", () => {
		expect(replies(source({ messages: [user, assistant([phase("仍在检查", "commentary")], "stop")] }))[0])
			.toMatchObject({ state: "incomplete", final: false, answer: [], process: [{ text: "仍在检查" }] });
	});

	it("用户 Shell 和压缩摘要不折入上一份模型回复", () => {
		const rows = transcriptReplies(source({ messages: [
			{ role: "compactionSummary", summary: "历史摘要", tokensBefore: 1000, timestamp: 0 }, user,
			assistant([text("报告")], "stop"),
			{ role: "bashExecution", command: "pwd", output: "/workspace", exitCode: 0, cancelled: false, truncated: false, timestamp: 200 },
		] }));
		expect(rows.map((row) => row.kind)).toEqual(["message", "message", "reply", "message"]);
	});

	it("运行时展开处理过程，已完成历史默认收起，最终正文始终在外面", () => {
		const messages = [user, assistant([thinking, call]), result];
		const live = renderToStaticMarkup(createElement(Transcript, { source: source({ messages, streaming: true }) }));
		expect(live).toContain('<details class="reply-process" open="">');
		const completed = renderToStaticMarkup(createElement(Transcript, { source: source({ messages: [...messages, assistant([text("最终报告")], "stop")] }) }));
		expect(completed).toContain('<details class="reply-process">');
		expect(completed).toContain('<div class="reply-answer"><article class="message assistant"><p>最终报告</p>');
	});

	it("纯文字回复不显示空的处理过程入口", () => {
		const html = renderToStaticMarkup(createElement(Transcript, { source: source({ messages: [user, assistant([text("直接回答")], "stop")] }) }));
		expect(html).toContain('<details class="reply-process" hidden="">');
		expect(html).toContain("直接回答");
	});
});
