import { createElement } from "react";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { SKILL_CONTEXT_MESSAGE, type SkillLoadDetails } from "../../src/harness/skill-context/types.ts";
import { formatSkillDisclosure } from "../../src/harness/skill-context/executor.ts";
import { GuiPayloads } from "../../src/gui/host/payloads.ts";
import { Message } from "../../src/gui/ui/content.tsx";
import { ToolActivity } from "../../src/gui/ui/tool-activity.tsx";
import { Transcript } from "../../src/gui/ui/transcript.tsx";
import type { ToolState } from "../../src/gui/ui/transcript-items.ts";
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
	return document(createElement(ToolActivity, { tool: { id: call.id, name: "skill", args: call.arguments, state, output } }));
}

describe("技能语义展示", () => {
	it("手动引用与模型调用都显示紧凑卡片，默认不挂载正文或原始数据", () => {
		const manual = document(createElement(Message, { entryId: "manual-1", value: {
			role: "custom", customType: SKILL_CONTEXT_MESSAGE, display: true, timestamp: 100,
			content: formatSkillDisclosure(details.name, body), details: { ...details, loadedBy: "manual" },
		} }));
		for (const [doc, loader] of [[manual, "手动引用"], [renderTool(), "模型调用"]] as const) {
			expect(doc.querySelector(".skill-activity .activity-summary")?.textContent).toContain(`技能${details.name}`);
			expect(doc.querySelector(".activity-summary")?.textContent).toContain(loader);
			expect(doc.querySelector(".activity-summary")?.textContent).toContain("已加载");
			expect(doc.querySelector(".activity-summary")?.getAttribute("aria-expanded")).toBe("false");
			expect(doc.toString()).not.toContain("先收集证据");
			expect(doc.toString()).not.toContain("test-hash");
			expect(doc.toString()).not.toContain("o-pi:skill");
		}
		expect(manual.querySelector("[data-entry-id]")?.getAttribute("data-entry-id")).toBe("manual-1");
	});

	it.each([
		["preparing", "生成参数"], ["pending", "等待加载"], ["running", "加载中"],
		["stopped", "已停止"], ["unavailable", "无加载结果"],
	] as const)("%s 不误报已加载", (state, label) => {
		const summary = renderTool(state, undefined).querySelector(".activity-summary")?.textContent;
		expect(summary).toContain(label);
		expect(summary).not.toContain("已加载");
	});

	it("重复加载明确说明未重复注入，失败摘要保留具体错误", () => {
		const duplicate = renderTool("completed", { content: [{ type: "text", text: formatSkillDisclosure(details.name, "") }], details: { ...details, deduplicated: true, chars: 0 } });
		expect(duplicate.querySelector(".activity-summary")?.textContent).toContain("已加载过（未重复注入）");
		const failed = renderTool("failed", { content: [], details: { status: "failed", error: { code: "SKILL_NOT_FOUND", message: "skill not found" } } });
		expect(failed.querySelector(".activity-summary")?.textContent).toContain("加载失败");
		expect(failed.querySelector(".activity-error")?.textContent).toBe("skill not found");
	});

	it("展开显示来源、根路径和 Markdown 正文，不显示披露标签或默认展示哈希", () => {
		const doc = document(createElement(ToolActivity, { tool: { id: call.id, name: "skill", args: call.arguments, state: "completed", output: result } }),
			new Map([[`skill:${call.id}`, true]]));
		expect(doc.querySelector(".skill-metadata")?.textContent).toContain("用户技能");
		expect(doc.querySelector(".skill-metadata")?.textContent).toContain("skill://debugging");
		expect(doc.querySelector(".skill-body h1")?.textContent).toBe("检查任务");
		expect(doc.toString()).not.toContain("invoked_skill");
		expect(doc.toString()).not.toContain("test-hash");
	});

	it.each([false, true])("完成后折叠仍在最外层摘要显示技能名称（含过程文字：%s）", (commentary) => {
		const doc = document(createElement(Transcript, { clear() {}, source: source({ messages: [
			assistant([...(commentary ? [{ type: "text" as const, text: "先加载技能" }] : []), call]), result,
			assistant([{ type: "text", text: "任务已完成" }], "stop"),
		] }) }));
		const outer = doc.querySelector(commentary ? ".assistant-reply > .reply-process" : ".reply-activity");
		expect(outer?.getAttribute("data-state")).toBe("closed");
		expect(outer?.querySelector(":scope > .disclosure-trigger")?.textContent).toContain("技能 debugging");
	});

	it("大体积结果的首屏保留技能状态，正文仍通过原有接口按需读取", () => {
		const payloads = new GuiPayloads();
		const full = { ...result, details: { ...details, chars: body.length * 10_000 }, content: [{ type: "text" as const, text: formatSkillDisclosure(details.name, body.repeat(10_000)) }] };
		const projected = payloads.project<ToolResultMessage<unknown>>(full);
		expect(projected.details).toMatchObject({ name: "debugging", loadedBy: "agent", deduplicated: false, guiOutputId: expect.any(String) });
		const doc = renderTool("completed", projected);
		expect(doc.querySelector(".activity-summary")?.textContent).toContain("已加载");
		const preview = projected.details;
		if (typeof preview !== "object" || preview === null || !("guiOutputId" in preview) || typeof preview.guiOutputId !== "string") throw new Error("缺少载荷 ID");
		expect(payloads.toolOutput(preview.guiOutputId)).toEqual({ content: full.content, details: full.details });
	});
});
