import { createElement } from "react";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { SKILL_CONTEXT_MESSAGE, type SkillLoadDetails } from "../../src/harness/skill-context/types.ts";
import { formatSkillDisclosure } from "../../src/harness/skill-context/executor.ts";
import { GuiPayloads } from "../../src/gui/host/payloads.ts";
import { Message } from "../../src/gui/ui/content/content.tsx";
import { ToolActivity } from "../../src/gui/ui/tools/tool-activity.tsx";
import { Transcript } from "../../src/gui/ui/transcript/transcript.tsx";
import type { ToolState } from "../../src/gui/ui/transcript/transcript-items.ts";
import { renderWithMemory } from "./render.ts";
import { assistant, source } from "./transcript-fixtures.ts";

const body = "# 检查任务\n\n先收集证据，再修改代码。";
const details: SkillLoadDetails = {
	name: "debugging", root: "skill://debugging", contentHash: "test-hash", scope: "user", loadedBy: "agent", deduplicated: false, chars: body.length,
};
const call = { type: "toolCall", id: "skill-1", name: "skill", arguments: { name: details.name } } as const;
const result: ToolResultMessage<SkillLoadDetails> = {
	role: "toolResult", toolCallId: call.id, toolName: "skill", isError: false, timestamp: 101,
	content: [{ type: "text", text: formatSkillDisclosure(details.name, body) }], details,
};
const document = (element: Parameters<typeof renderWithMemory>[0], memory?: Map<string, boolean | null>) =>
	parseHTML(renderWithMemory(element, memory)).document;

function renderTool(state: ToolState = "completed", output: { content: unknown; details?: unknown } | undefined = state === "completed" ? result : undefined) {
	return document(createElement(ToolActivity, { tool: { id: call.id, name: "skill", args: call.arguments, state, output: output ? { kind: "inline", value: output } : undefined } }));
}

describe("技能语义展示", () => {
	it("手动引用与模型调用都显示紧凑卡片，默认不挂载正文或原始数据", () => {
		const manual = document(createElement(Message, { entryId: "manual-1", value: {
			role: "custom", customType: SKILL_CONTEXT_MESSAGE, display: true, timestamp: 100,
			content: formatSkillDisclosure(details.name, body), details: { ...details, loadedBy: "manual" },
		} }));
		for (const doc of [manual, renderTool()]) {
			expect(doc.querySelector(".activity-state > svg")).not.toBeNull();
			expect(doc.querySelector(".activity-state")?.getAttribute("data-state")).toBe("completed");
			expect(doc.querySelector(".activity-summary")?.getAttribute("aria-expanded")).toBe("false");
			expect(doc.toString()).not.toContain("先收集证据");
			expect(doc.toString()).not.toContain("test-hash");
			expect(doc.toString()).not.toContain("o-pi:skill");
		}
		expect(manual.querySelector("[data-entry-id]")?.getAttribute("data-entry-id")).toBe("manual-1");
	});

	it.each(["preparing", "pending", "running", "stopped", "unavailable"] as const)("保留 %s 状态", (state) => {
		const doc = renderTool(state, undefined);
		expect(doc.querySelector(".activity-state")?.getAttribute("data-state")).toBe(state);
	});

	it("保留失败状态和原始错误", () => {
		const failed = renderTool("failed", { content: [], details: { status: "failed", error: { code: "SKILL_NOT_FOUND", message: "skill not found" } } });
		expect(failed.querySelector(".activity-state")?.getAttribute("data-state")).toBe("failed");
		expect(failed.querySelector(".activity-error")?.textContent).toBe("skill not found");
	});

	it("展开显示来源、根路径和 Markdown 正文，不显示披露标签或默认展示哈希", () => {
		const doc = document(createElement(ToolActivity, { tool: { id: call.id, name: "skill", args: call.arguments, state: "completed", output: { kind: "inline", value: result } } }),
			new Map([[`skill:${call.id}`, true]]));
		expect(doc.querySelector(".skill-metadata")?.textContent).toContain("skill://debugging");
		expect(doc.querySelector(".skill-body h1")?.textContent).toBe("检查任务");
		expect(doc.toString()).not.toContain("invoked_skill");
		expect(doc.toString()).not.toContain("test-hash");
	});

	it.each([false, true])("完成后折叠在最外层摘要仅显示技能数量（含过程文字：%s）", (commentary) => {
		const doc = document(createElement(Transcript, { clear() {}, source: source({ messages: [
			assistant([...(commentary ? [{ type: "text" as const, text: "先加载技能" }] : []), call]), result,
			assistant([{ type: "text", text: "任务已完成" }], "stop"),
		] }) }));
		const outer = doc.querySelector(commentary ? ".assistant-reply > .reply-process" : ".reply-activity");
		expect(outer?.getAttribute("data-state")).toBe("closed");
	});

	it("大体积结果的首屏保留技能状态，正文仍通过原有接口按需读取", () => {
		const payloads = new GuiPayloads();
		const full = { ...result, details: { ...details, chars: body.length * 10_000 }, content: [{ type: "text" as const, text: formatSkillDisclosure(details.name, body.repeat(10_000)) }] };
		const projected = payloads.message(full);
		if (projected.role !== "toolResult" || projected.output.kind !== "reference") throw new Error("缺少载荷引用");
		expect(projected.output.preview.details).toMatchObject({ name: "debugging", loadedBy: "agent", deduplicated: false });
		const doc = document(createElement(ToolActivity, { tool: { id: call.id, name: "skill", args: call.arguments, state: "completed", output: projected.output } }));
		expect(doc.querySelector(".activity-state > svg")).not.toBeNull();
		expect(payloads.toolOutput(projected.output.id)).toEqual({ content: full.content, details: full.details });
	});
});
