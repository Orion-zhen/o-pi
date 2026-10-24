import { act, createElement, Fragment } from "react";
import { useReactFixture } from "./react-fixture.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DisclosureMemoryContext } from "../../src/gui/frontend/ui/disclosure-memory.ts";
import { TooltipProvider } from "../../src/gui/frontend/ui/tooltip.tsx";
import { GuiQueryContext } from "../../src/gui/frontend/connection/query-context.ts";
import { ReplyItems } from "../../src/gui/frontend/features/chat/transcript/transcript-sections.tsx";
import { transcriptReplies } from "../../src/gui/frontend/features/chat/transcript/transcript-replies.ts";
import type { TranscriptSource } from "../../src/gui/frontend/features/chat/transcript/transcript-items.ts";
import { assistant, call, result, source } from "./transcript-fixtures.ts";

const renderRoot = useReactFixture(() => {
	Reflect.deleteProperty(window.HTMLElement.prototype, "getAnimations");
	vi.restoreAllMocks();
});
const memory = new Map<string, boolean | null>();
const query = async () => { throw new Error("内联结果不应请求载荷"); };
const user = { role: "user", content: "检查项目", timestamp: 1 } as const;
const completed = {
	...assistant([{ type: "text", text: "已检查组件" }, call]),
	opiPerformance: { bodyTps: { 0: 2 }, ttftWithThinkingMs: 100, ttftWithoutThinkingMs: 100 },
};
const initial = source({ messages: [user, completed, result], streaming: true });
async function render(value: TranscriptSource, entryIds = ["user", "checked", "result", "live"], pruned: ReadonlySet<string> = new Set()) {
	const reply = transcriptReplies(value, pruned).find((row) => row.kind === "reply");
	if (!reply) throw new Error("缺少回复");
	await renderRoot(createElement(GuiQueryContext, { value: query },
		createElement(TooltipProvider, null, createElement(DisclosureMemoryContext, { value: memory },
			createElement(Fragment, null,
				createElement(ReplyItems, { items: reply.process, entryIds }),
				createElement(ReplyItems, { items: reply.answer, entryIds, showMetrics: false }))))));
}
function button(selector: string): HTMLButtonElement {
	const element = document.querySelector<HTMLButtonElement>(selector);
	if (!element) throw new Error(`缺少按钮 ${selector}`);
	return element;
}

beforeEach(() => {
	vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
	Object.defineProperty(window.HTMLElement.prototype, "getAnimations", { configurable: true, value: () => [] });
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
	vi.stubGlobal("cancelAnimationFrame", clearTimeout);
	memory.clear();
});

describe("当前轮次中的稳定内容", () => {
	it("正文结束时更新速度，后续分块独立结算，最终回答不依赖消息统计显示速度", async () => {
		const message = assistant([{ type: "text", text: "第一段" }], "pending");
		await render(source({ messages: [user], streaming: true, streamingMessage: message }));
		expect(document.querySelector(".generation-speed")?.textContent).toBe("速度 —");

		const firstEnded = { ...message,
			opiPerformance: { bodyTps: { 0: 10 }, ttftWithThinkingMs: 100, ttftWithoutThinkingMs: 100 } };
		await render(source({ messages: [user], streaming: true, streamingMessage: firstEnded }));
		expect(document.querySelector(".generation-speed")?.textContent).toBe("速度 10.0 tok/s");

		const next = { ...firstEnded, content: [...message.content, { type: "text", text: "第二段" } as const] };
		await render(source({ messages: [user], streaming: true, streamingMessage: next }));
		expect([...document.querySelectorAll(".generation-speed")].map((speed) => speed.textContent))
			.toEqual(["速度 10.0 tok/s", "速度 —"]);

		const ended = { ...next, opiPerformance: { ...next.opiPerformance, bodyTps: { 0: 10, 1: 20 } } };
		await render(source({ messages: [user], streaming: true, streamingMessage: ended }));
		expect([...document.querySelectorAll(".generation-speed")].map((speed) => speed.textContent))
			.toEqual(["速度 10.0 tok/s", "速度 20.0 tok/s"]);
		await render(source({ messages: [user, { ...ended, stopReason: "stop" }] }));
		expect([...document.querySelectorAll(".generation-speed")].map((speed) => speed.textContent))
			.toEqual(["速度 10.0 tok/s", "速度 20.0 tok/s"]);
		expect(document.querySelector(".reply-metrics")).toBeNull();
	});

	it("后续正文流式生成时不重复格式化已完成消息的统计", async () => {
		await render(initial);
		const number = vi.spyOn(Number.prototype, "toLocaleString");
		for (const text of ["继续", "继续检查"]) {
			await render({ ...initial, streamingMessage: assistant([{ type: "text", text }], "pending") });
			expect(document.body.textContent).toContain(text);
		}
		expect(number).not.toHaveBeenCalled();
	});

	it("消息结束后显示用量，工具执行失败后更新状态和错误", async () => {
		const message = assistant([{ type: "text", text: "检查组件" }, call], "pending");
		await render(source({ messages: [user], streaming: true, streamingMessage: message }));
		expect(document.querySelector(".reply-metrics")).toBeNull();
		const ended = { ...message, stopReason: "toolUse" as const, usage: { ...message.usage, output: 42, totalTokens: 43 },
			opiPerformance: { bodyTps: { 0: 2 }, ttftWithThinkingMs: 100, ttftWithoutThinkingMs: 100 } };
		await render(source({ messages: [user, ended], streaming: true,
			liveTools: [{ toolCallId: call.id, toolName: call.name, args: call.arguments, output: undefined }] }));
		expect(document.querySelector(".reply-metrics")?.textContent).toContain("输出 42");
		expect(document.querySelector(".tool-activity")?.getAttribute("data-state")).toBe("running");
		await render(source({ messages: [user, ended, { ...result, isError: true,
			content: [{ type: "text", text: "读取失败" }], details: { error: { code: "FAILED", message: "读取失败" } } }], streaming: true }));
		expect(document.querySelector(".activity-error")?.textContent).toBe("读取失败");
		expect(document.querySelector(".tool-activity")?.getAttribute("data-state")).toBe("failed");
		expect(document.querySelector(".reply-counts")?.textContent).toContain("1 次失败");
	});

	it("追加消息和裁剪工具结果后，已完成正文的速度与工具展开状态保持不变", async () => {
		await render(initial);
		expect(document.querySelector('[data-entry-id="checked"]')?.closest(".reply-body")
			?.querySelector(".reply-metrics .generation-speed")?.textContent).toBe("速度 2.0 tok/s");
		await act(async () => button(".reply-activity > .disclosure-trigger").click());
		await act(async () => button(".activity-summary").click());
		const summary = button(".activity-summary");
		const output = document.querySelector(".activity-body pre");
		expect(output?.textContent).toContain("file content");
		const updated = { ...initial,
			messages: [...initial.messages, assistant([{ type: "text", text: "新说明" }, { ...call, id: "next" }])] };
		await render(updated, ["user", "checked", "result", "next-entry"], new Set([call.id]));
		expect(document.querySelector('.reply-body [data-entry-id="checked"] > p')?.textContent).toBe("已检查组件");
		const metrics = document.querySelector('[data-entry-id="checked"]')?.closest(".reply-body")?.querySelector(".reply-metrics");
		expect(metrics?.querySelector(".generation-speed")?.textContent).toBe("速度 2.0 tok/s");
		expect(metrics?.textContent).toContain("输出");
		expect(document.querySelector(".pruned-text-active")).not.toBeNull();
		expect(button(".activity-summary")).toBe(summary);
		expect(summary.getAttribute("aria-expanded")).toBe("true");
		expect(document.querySelector(".activity-body pre")).toBe(output);
	});
});
