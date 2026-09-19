import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { Transcript } from "../../src/gui/ui/transcript.tsx";
import type { TextContent, UserMessage } from "@earendil-works/pi-ai";
import { transcriptReplies } from "../../src/gui/ui/transcript-replies.ts";
import { assistant, call, result, source } from "./transcript-fixtures.ts";

const user: UserMessage = { role: "user", content: "检查项目", timestamp: 1 };
const text = (value: string): TextContent => ({ type: "text", text: value });
const phase = (value: string, phase: "commentary" | "final_answer"): TextContent => ({
	...text(value), textSignature: JSON.stringify({ v: 1, id: `msg-${phase}`, phase }),
});
const thinking = { type: "thinking", thinking: "检查文件边界" } as const;
const replies = (value: ReturnType<typeof source>) => transcriptReplies(value).filter((row) => row.kind === "reply");

describe("整轮处理过程折叠", () => {
	it("完成后外层收起中途正文，内层仅折叠思考和工具，最终报告留在外面", () => {
		const second = { ...call, id: "read-2" };
		const third = { ...call, id: "read-3" };
		const snapshot = source({ messages: [user,
			assistant([text("先检查组件"), thinking, call]), result,
			assistant([thinking, text(" \n\t"), second]), { ...result, toolCallId: second.id },
			assistant([text("\n"), thinking, text("接下来检查样式"), third]), { ...result, toolCallId: third.id },
			assistant([thinking, text("检查完成"), text("没有发现问题"), text("\n\t")], "stop"),
		] });
		const rows = replies(snapshot);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ state: "completed", answer: [{ text: "检查完成" }, { text: "没有发现问题" }] });
		expect(rows[0]?.process.filter((item) => item.kind === "text").map((item) => item.text)).toEqual(["先检查组件", "接下来检查样式"]);
		expect(rows[0]?.process.filter((item) => item.kind === "tool")).toHaveLength(3);
		expect(rows[0]?.process.filter((item) => item.kind === "thinking")).toHaveLength(4);
		expect(rows[0]?.answer).toHaveLength(2);
		const document = parseHTML(renderToStaticMarkup(createElement(Transcript, { source: snapshot, clear: () => {} }))).document;
		expect(document.querySelector(".assistant-reply > .reply-process")?.getAttribute("data-state")).toBe("closed");
		expect([...document.querySelectorAll(".reply-turn-content > .reply-body")].map((body) => body.querySelector("article")?.textContent))
			.toEqual(["先检查组件", "接下来检查样式"]);
		expect(document.querySelectorAll(".reply-activity .reply-body")).toHaveLength(0);
		expect([...document.querySelectorAll(".reply-activity .reply-counts")].map((counts) => counts.textContent))
			.toEqual(["3 段思考 · 2 次工具调用", "1 段思考 · 1 次工具调用"]);
		expect([...document.querySelectorAll(".reply-activity")].every((activity) => activity.getAttribute("data-state") === "closed")).toBe(true);
		expect(document.querySelectorAll(".reply-body > .message-identity")).toHaveLength(3);
		expect(document.querySelectorAll('.reply-turn-content [aria-label="本条消息统计"]')).toHaveLength(2);
		expect(document.querySelector(".reply-answer")?.textContent).toContain("检查完成没有发现问题");
	});

	it("阶段标记区分同一条消息中的 commentary 和 final_answer", () => {
		const reply = assistant([phase("已经找到原因", "commentary"), phase("最终报告", "final_answer")], "stop");
		const rows = replies(source({ messages: [user, reply] }));
		expect(rows[0]?.process).toMatchObject([{ kind: "text", text: "已经找到原因" }]);
		expect(rows[0]?.answer).toMatchObject([{ text: "最终报告" }]);
		const live = replies(source({ messages: [user], streamingMessage: reply, streaming: true }));
		expect(live[0]).toMatchObject({ state: "running", tracking: true });
	});

	it("流式正文出现时仅折叠前面的思考和工具，后续工具不隐藏中途正文", () => {
		const snapshot = source({ messages: [user, assistant([thinking, text(" \n"), call]), result],
			streamingMessage: assistant([thinking, text("\n\t")], "pending"), streaming: true });
		const blank = parseHTML(renderToStaticMarkup(createElement(Transcript, { source: snapshot, clear: () => {} }))).document;
		expect(replies(snapshot)[0]?.answer).toEqual([]);
		expect(blank.querySelectorAll(".reply-process")).toHaveLength(1);
		expect(blank.querySelector(".reply-activity")?.getAttribute("data-state")).toBe("open");
		expect(blank.querySelector(".reply-counts")?.textContent).toBe("2 段思考 · 1 次工具调用");
		expect(blank.querySelectorAll(".assistant-reply .reply-body, .assistant-reply .message-identity")).toHaveLength(0);
		const live = assistant([thinking, text("我先检查")], "pending");
		const streaming = replies(source({ messages: [user], streamingMessage: live, streaming: true }));
		expect(streaming[0]).toMatchObject({ answer: [{ text: "我先检查" }] });
		const merged = parseHTML(renderToStaticMarkup(createElement(Transcript, {
			source: source({ messages: [user], streamingMessage: live, streaming: true }), clear: () => {},
		}))).document;
		expect(merged.querySelectorAll(".reply-process")).toHaveLength(1);
		expect(merged.querySelector(".reply-activity")?.getAttribute("data-state")).toBe("closed");
		expect(merged.querySelector(".reply-answer")?.textContent).toContain("我先检查");
		const calling = replies(source({ messages: [user], streamingMessage: assistant([...live.content, call]), streaming: true }));
		expect(calling[0]).toMatchObject({ key: streaming[0]?.key, answer: [] });
		expect(calling[0]?.process).toContainEqual(expect.objectContaining({ kind: "text", text: "我先检查" }));
		const document = parseHTML(renderToStaticMarkup(createElement(Transcript, {
			source: source({ messages: [user], streamingMessage: assistant([...live.content, call]), streaming: true }), clear: () => {},
		}))).document;
		expect(document.querySelector(".assistant-reply > .reply-process")?.getAttribute("data-state")).toBe("open");
		expect([...document.querySelectorAll(".reply-activity")].map((activity) => activity.getAttribute("data-state"))).toEqual(["closed", "open"]);
		expect(document.querySelector(".reply-turn-content > .reply-body article")?.textContent).toBe("我先检查");
		const completed = replies(source({ messages: [user, assistant([...live.content, call]), result, assistant([text("最终报告")], "stop")] }));
		expect(completed[0]).toMatchObject({ key: streaming[0]?.key, answer: [{ text: "最终报告" }] });
	});

	it("整轮结束才折叠外层，旧字符串签名仍能显示", () => {
		const reply = assistant([{ ...text("最终正文"), textSignature: "msg_legacy" }], "stop");
		expect(replies(source({ messages: [user], streamingMessage: reply, streaming: true }))[0]?.tracking).toBe(true);
		expect(replies(source({ messages: [user, reply], streaming: true }))[0]?.tracking).toBe(true);
		expect(replies(source({ messages: [user, reply] }))[0]?.tracking).toBe(false);
	});

	it("每条用户消息独立分组，只有最后一组处于生成中", () => {
		const rows = replies(source({ messages: [user, assistant([text("第一份回复")], "stop"),
			{ ...user, content: "继续检查", timestamp: 2 }], streamingMessage: assistant([thinking], "pending"), streaming: true }));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ state: "completed" });
		expect(rows[1]).toMatchObject({ state: "running", answer: [] });
		expect(rows[0]?.key).not.toBe(rows[1]?.key);
	});

	it.each([false, true])("引导接续结束追踪，不把工具返回错误（%s）当成阶段失败", (isError) => {
		const messages = [user, assistant([thinking, text("先检查"), call]), { ...result, isError }];
		const running = replies(source({ messages, streaming: true }));
		expect(running[0]).toMatchObject({ state: "running", tracking: true });
		const nextUser = { ...user, content: "只检查样式", timestamp: 2 };
		const continued = replies(source({ messages: [...messages, nextUser], streaming: true }));
		expect(continued).toHaveLength(2);
		expect(continued[0]).toMatchObject({ key: running[0]?.key, state: "continued", tracking: false, answer: [] });
		expect(continued[1]).toMatchObject({ state: "running", tracking: true });
		const history = replies(source({ messages: [...messages, nextUser, assistant([text("检查完成")], "stop")] }));
		expect(history.map((row) => [row.state, row.tracking])).toEqual([["continued", false], ["completed", false]]);
	});

	it("模型返回空消息后追加用户消息，仍保留未完成状态", () => {
		const rows = replies(source({ messages: [user, assistant([call]), result, assistant([], "stop"),
			{ ...user, content: "继续", timestamp: 2 }], streaming: true }));
		expect(rows[0]).toMatchObject({ state: "incomplete", tracking: false });
	});

	it("连续引导不生成空的历史过程，只有最后一个阶段需要追踪", () => {
		const rows = transcriptReplies(source({ messages: [user, assistant([thinking, call]), result,
			{ ...user, content: "先检查样式", timestamp: 2 }, { ...user, content: "不要改代码", timestamp: 3 }], streaming: true }));
		expect(rows.map((row) => row.kind)).toEqual(["message", "reply", "message", "message", "reply"]);
		expect(rows.filter((row) => row.kind === "reply").map((row) => row.tracking)).toEqual([false, true]);
	});

	it("仅有中途说明的正常阶段也能接续，不提升为最终正文", () => {
		const rows = replies(source({ messages: [user, assistant([phase("继续检查", "commentary")], "stop"),
			{ ...user, content: "换个方向", timestamp: 2 }], streaming: true }));
		expect(rows[0]).toMatchObject({ state: "continued", tracking: false, answer: [] });
	});

	it.each(["aborted", "error", "length"] as const)("后续用户消息不会掩盖 %s 状态", (stopReason) => {
		const rows = replies(source({ messages: [user, assistant([thinking, text("部分正文")], stopReason),
			{ ...user, content: "换个方向", timestamp: 2 }], streaming: true }));
		expect(rows[0]).toMatchObject({ state: stopReason === "aborted" ? "stopped" : stopReason === "error" ? "failed" : "incomplete", tracking: false, answer: [{ text: "部分正文" }] });
	});

	it("缺失或中止的工具结果不因后续用户消息而被标为正常接续", () => {
		for (const results of [[], [{ ...result, isError: true, details: { status: "aborted" } }]]) {
			const rows = replies(source({ messages: [user, assistant([call]), ...results,
				{ ...user, content: "换个方向", timestamp: 2 }], streaming: true }));
			expect(rows[0]).toMatchObject({ state: "incomplete", tracking: false });
		}
	});

	it.each(["aborted", "error", "length"] as const)("%s 时保留部分正文并明确标注状态，不冒充完成", (stopReason) => {
		const message = { ...assistant([thinking, text("已生成的部分")], stopReason), errorMessage: "任务没有正常完成" };
		const row = replies(source({ messages: [user, message] }))[0];
		expect(row).toMatchObject({ state: stopReason === "aborted" ? "stopped" : stopReason === "error" ? "failed" : "incomplete", tracking: false, answer: [{ text: "已生成的部分" }], error: "任务没有正常完成" });
		expect(row?.process.some((item) => item.kind === "error")).toBe(false);
	});

	it("重试期间不把失败的片段当最终回复，恢复后将旧错误归入过程", () => {
		const failed = { ...assistant([text("失败前的部分")], "error"), errorMessage: "暂时不可用" };
		const retrying = replies(source({ messages: [user, failed], retrying: true }));
		expect(retrying[0]).toMatchObject({ state: "running", retrying: true, tracking: true, answer: [] });
		const completed = replies(source({ messages: [user, failed, assistant([text("重试完成")], "stop")] }));
		expect(completed[0]).toMatchObject({ key: retrying[0]?.key, state: "completed", error: undefined });
		expect(completed[0]?.process).toContainEqual(expect.objectContaining({ kind: "error", text: "暂时不可用" }));
	});

	it("没有最终正文时不提升旧说明，孤立工具结果仍可查看", () => {
		const noFinal = replies(source({ messages: [user, assistant([text("开始检查"), call]), result, assistant([], "stop")] }));
		expect(noFinal[0]).toMatchObject({ state: "incomplete", tracking: false, answer: [] });
		const orphan = replies(source({ messages: [result] }));
		expect(orphan[0]?.process).toMatchObject([{ kind: "tool", tool: { output: result } }]);
		const document = parseHTML(renderToStaticMarkup(createElement(Transcript, {
			source: source({ messages: [result] }), clear: () => {},
		}))).document;
		expect(document.querySelectorAll(".reply-process")).toHaveLength(1);
		expect(document.querySelector(".reply-activity")?.getAttribute("data-state")).toBe("closed");
	});

	it("仅有 commentary 的回复不会被标为最终报告", () => {
		expect(replies(source({ messages: [user, assistant([phase("仍在检查", "commentary")], "stop")] }))[0])
			.toMatchObject({ state: "incomplete", answer: [], process: [{ text: "仍在检查" }] });
	});

	it("用户 Shell 和压缩摘要不折入上一份模型回复", () => {
		const rows = transcriptReplies(source({ messages: [
			{ role: "compactionSummary", summary: "历史摘要", tokensBefore: 1000, timestamp: 0 }, user,
			assistant([text("报告")], "stop"),
			{ role: "bashExecution", command: "pwd", output: "/workspace", exitCode: 0, cancelled: false, truncated: false, timestamp: 200 },
		] }));
		expect(rows.map((row) => row.kind)).toEqual(["message", "message", "reply", "message"]);
	});

});
