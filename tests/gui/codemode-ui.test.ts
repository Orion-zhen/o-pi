import { createElement } from "react";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { GuiSnapshot } from "../../src/gui/contract.ts";
import { ToolSelection } from "../../src/gui/ui/tool-selection.tsx";
import { ToolActivity } from "../../src/gui/ui/tool-activity.tsx";
import type { ToolActivity as Activity } from "../../src/gui/ui/transcript-items.ts";
import { renderWithMemory } from "./render.ts";

const tools: GuiSnapshot["tools"] = [
	{ name: "codemode", exposure: "model-only", description: "Script", enabled: true, available: true, callable: false },
	{ name: "skill", exposure: "model-only", description: "Load", enabled: true, available: true, callable: false },
	{ name: "read", exposure: "direct", description: "Read", enabled: true, available: true, callable: true },
	{ name: "bash", exposure: "direct", description: "Run", enabled: false, available: true, callable: false },
	{ name: "search", exposure: "deferred", description: "Search", enabled: false, available: true, callable: true },
];
const tool: Activity = {
	id: "code-1", name: "codemode", state: "running", args: { code: 'text(await tools.read({path:"a.ts"}));' }, output: undefined,
	nestedCalls: { complete: false, calls: [
		{ id: "code-1/1", name: "find", arguments: { query: "a.ts" }, status: "ok", durationMs: 10 },
		{ id: "code-1/2", name: "read", arguments: { path: "a.ts" }, status: "unfinished" },
	] },
};
const renderTool = (value: Activity, expanded?: boolean) => parseHTML(renderWithMemory(createElement(ToolActivity, { tool: value }),
	new Map(expanded === undefined ? [] : [[`tool:${value.id}`, expanded]]))).document;

describe("codemode 工具层级", () => {
	it("只有模型专用工具平级，未勾选的延迟工具仍显示为可调用而非禁用开关", () => {
		const doc = parseHTML(renderWithMemory(createElement(ToolSelection, {
			snapshot: { tools, modelTools: ["codemode", "skill"] }, send: async () => true, disabled: false,
		}))).document;
		expect([...doc.querySelectorAll(".tool-selection-children [data-tool-option]")].map((row) => row.getAttribute("data-tool-option")))
			.toEqual(["read", "bash", "search"]);
		expect(doc.querySelector('.tool-selection > [data-tool-option="skill"]')).not.toBeNull();
		expect(doc.querySelector('[data-tool-option="search"] [role="checkbox"]')).toBeNull();
		expect(doc.querySelector('[data-tool-option="search"]')?.textContent).toContain("可调用 · 按需发现");
		expect(doc.querySelector('[aria-label="bash"]')?.getAttribute("aria-checked")).toBe("false");
		expect(doc.querySelector(".tool-mode-toggle")?.textContent).toContain("2 个可用子工具");
	});

	it("关闭模式恢复平级选择，保留普通工具的勾选", () => {
		const doc = parseHTML(renderWithMemory(createElement(ToolSelection, {
			snapshot: { tools: tools.map((item) => item.name === "codemode" ? { ...item, enabled: false as const } : item), modelTools: ["skill", "read"] },
			send: async () => true, disabled: false,
		}))).document;
		expect(doc.querySelector(".tool-selection-children")).toBeNull();
		expect(doc.querySelector('.tool-selection > [data-tool-option="read"]')).not.toBeNull();
		expect(doc.querySelector('[aria-label="read"]')?.getAttribute("aria-checked")).toBe("true");
		expect(doc.querySelector('[aria-label="bash"]')?.getAttribute("aria-checked")).toBe("false");
	});
});

describe("codemode 执行容器", () => {
	it("运行时展开，子调用复用工具摘要，脚本默认不展开", () => {
		const doc = renderTool({ ...tool, output: { kind: "inline", value: { content: "Script running" } } });
		expect(doc.querySelector(".codemode-output")).toBeNull();
		expect(doc.querySelector('.codemode-activity > [data-slot="collapsible"]')?.getAttribute("data-state")).toBe("open");
		expect(doc.querySelectorAll("[data-tool-call-id]")).toHaveLength(1);
		expect([...doc.querySelectorAll("[data-nested-tool-call-id]")].map((row) => row.getAttribute("data-state"))).toEqual(["completed", "running"]);
		expect(doc.querySelector('[data-nested-tool-call-id="code-1/2"] .activity-target')?.textContent).toBe("a.ts");
		expect(doc.querySelector(".tool-parameters")?.getAttribute("data-state")).toBe("closed");
		expect(doc.querySelector(".tool-note")).toBeNull();
	});

	it("成功后收起，手动展开优先，父成功不掩盖已捕获的子失败", () => {
		const completed: Activity = { ...tool, state: "completed", nestedCalls: { complete: true, calls: [
			{ id: "code-1/1", name: "read", arguments: { path: "missing.ts" }, status: "error", error: "File not found" },
		] }, output: { kind: "inline", value: { content: "processed" } } };
		expect(renderTool(completed).querySelector('.codemode-activity > [data-slot="collapsible"]')?.getAttribute("data-state")).toBe("closed");
		const doc = renderTool(completed, true);
		expect(doc.querySelector(".codemode-activity")?.getAttribute("data-state")).toBe("completed");
		expect(doc.querySelector(".nested-failures")?.textContent).toContain("1 次失败");
		expect(doc.querySelector("[data-nested-tool-call-id] .activity-state")?.getAttribute("data-state")).toBe("failed");
		expect(doc.querySelector('[role="alert"]')?.textContent).toBe("File not found");
		expect(doc.querySelector("[data-nested-tool-call-id] dt")?.textContent).toBe("path");
		expect(doc.querySelector(".codemode-output > .disclosure-trigger")?.textContent).toContain("输出给模型");
		expect(doc.querySelector(".tool-note")).toBeNull();
	});

	it("停止后保留已完成子调用，在途子调用标为停止", () => {
		const doc = renderTool({ ...tool, state: "stopped" }, true);
		expect([...doc.querySelectorAll("[data-nested-tool-call-id]")].map((row) => row.getAttribute("data-state"))).toEqual(["completed", "stopped"]);
		expect(doc.querySelector(".codemode-body")?.textContent).toContain("调用记录不完整");
	});

	it("失败自动展开，缺失参数和未完成记录不伪装成成功", () => {
		const failed: Activity = { ...tool, state: "failed", nestedCalls: { complete: false, calls: [
			{ id: "code-1/1", name: "bash", argumentsBytes: 100000, status: "error", error: "Blocked" },
			{ id: "code-1/2", name: "read", arguments: { path: "a.ts" }, status: "unfinished" },
		] } };
		const doc = renderTool(failed);
		expect(doc.querySelector('.codemode-activity > [data-slot="collapsible"]')?.getAttribute("data-state")).toBe("open");
		expect(doc.querySelector('[data-nested-tool-call-id="code-1/1"]')?.textContent).toContain("参数未保留（100000 字节）");
		expect(doc.querySelector('[data-nested-tool-call-id="code-1/2"] .activity-state')?.textContent).toContain("未完成");
		expect(doc.querySelector(".codemode-body")?.textContent).toContain("调用记录不完整");
		expect(renderTool(failed, false).querySelector('.codemode-activity > [data-slot="collapsible"]')?.getAttribute("data-state")).toBe("closed");
	});
});
