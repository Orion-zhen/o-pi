import { act, createElement, Fragment } from "react";
import { useReactFixture } from "./react-fixture.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assistantKey } from "../../src/gui/message-metrics.ts";
import { DisclosureMemoryContext } from "../../src/gui/ui/components/disclosure-memory.ts";
import { TooltipProvider } from "../../src/gui/ui/components/ui/tooltip.tsx";
import { GuiQueryContext } from "../../src/gui/ui/runtime/payload.tsx";
import { ReplyItems } from "../../src/gui/ui/transcript/transcript-sections.tsx";
import { transcriptReplies } from "../../src/gui/ui/transcript/transcript-replies.ts";
import type { TranscriptSource } from "../../src/gui/ui/transcript/transcript-items.ts";
import { assistant, call, result, source } from "./transcript-fixtures.ts";

const renderRoot = useReactFixture(() => {
	Reflect.deleteProperty(window.HTMLElement.prototype, "getAnimations");
	vi.restoreAllMocks();
});
const memory = new Map<string, boolean | null>();
const query = async () => { throw new Error("内联结果不应请求载荷"); };
const completed = assistant([{ type: "text", text: "已检查组件" }, call]);
const initial = source({ messages: [{ role: "user", content: "检查项目", timestamp: 1 }, completed, result], streaming: true });
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
	it("新正文和工具进度不重复格式化已完成消息的统计", async () => {
		await render(initial);
		const number = vi.spyOn(Number.prototype, "toLocaleString");
		for (const text of ["继续", "继续检查"]) {
			await render({ ...initial, streamingMessage: assistant([{ type: "text", text }], "pending") });
			expect(document.body.textContent).toContain(text);
		}
		await render({ ...initial, liveTools: [{ toolCallId: "next", toolName: "bash", args: { command: "pwd" }, status: "running", output: undefined }] });
		expect(document.querySelector('[data-tool-call-id="next"]')?.getAttribute("data-state")).toBe("running");
		expect(number).not.toHaveBeenCalled();
	});

	it("模型、用量及工具错误变化不会被稳定内容比较忽略", async () => {
		await render(initial);
		const updated: TranscriptSource = { ...initial, messages: initial.messages.map((message) => {
			if (message.role === "assistant") return { ...message, model: "更新后的模型", usage: { ...message.usage, output: 42 } };
			if (message.role === "toolResult") return { ...message, isError: true,
				output: { kind: "inline", value: { content: [{ type: "text", text: "读取失败" }], details: { error: { code: "FAILED", message: "读取失败" } } } } };
			return message;
		}) };
		await render(updated);
		expect(document.querySelector(".message-identity")?.textContent).toContain("更新后的模型");
		expect(document.querySelector(".reply-metrics")?.textContent).toContain("输出 42");
		expect(document.querySelector(".activity-error")?.textContent).toBe("读取失败");
		expect(document.querySelector(".tool-activity")?.getAttribute("data-state")).toBe("failed");
		expect(document.querySelector(".reply-counts")?.textContent).toContain("1 次失败");
	});

	it("统计耗时与条目定位变化仍更新，展开状态跨消息追加保留", async () => {
		await render(initial);
		await act(async () => button(".reply-activity > .disclosure-trigger").click());
		await act(async () => button(".activity-summary").click());
		const summary = button(".activity-summary");
		const output = document.querySelector(".activity-body pre");
		expect(output?.textContent).toContain("file content");
		const updated = { ...initial, messageDurations: { [assistantKey(completed)]: 500 },
			messages: [...initial.messages, assistant([{ type: "text", text: "新说明" }, { ...call, id: "next" }])] };
		await render(updated, ["user", "renamed-entry", "result", "next-entry"], new Set([call.id]));
		expect(document.querySelector('.reply-body [data-entry-id="renamed-entry"]')?.textContent).toBe("已检查组件");
		expect(document.querySelector(".reply-metrics")?.textContent).toContain("速度 2.0 tok/s");
		expect(document.querySelector(".pruned-text-active")).not.toBeNull();
		expect(button(".activity-summary")).toBe(summary);
		expect(summary.getAttribute("aria-expanded")).toBe("true");
		expect(document.querySelector(".activity-body pre")).toBe(output);
	});
});
