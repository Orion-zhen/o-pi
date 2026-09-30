import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	TOOL_SELECTION_ENTRY, ToolSelectionController, type ToolSelectionEntryData,
} from "../../../src/harness/tool-defaults/controller.ts";

describe("ToolSelectionController", () => {
	it("隐藏工具不展示也不激活，脚本和延迟工具标明曝光方式", () => {
		const harness = createHarness(["read", "hidden", "deferred", "script"]);
		harness.port.getAllTools = () => [
			makeToolInfo("read"), { ...makeToolInfo("hidden"), exposure: "hidden" },
			{ ...makeToolInfo("deferred"), exposure: "deferred" },
			{ ...makeToolInfo("script"), exposure: "codemode" },
		];
		const controller = new ToolSelectionController(harness.port);
		controller.set("hidden", true);
		expect(harness.entries).toEqual([]);
		expect(controller.listTools().map(({ name, exposure }) => ({ name, exposure }))).toEqual([
			{ name: "read", exposure: "direct" }, { name: "deferred", exposure: "deferred" }, { name: "script", exposure: "codemode" },
		]);
	});

	it("继承 SDK 初始选择，并将手动选择保存到会话", () => {
		const harness = createHarness(["read", "bash", "web"], ["read"]);
		const controller = new ToolSelectionController(harness.port);
		expect(controller.restore({ branchEntries: [] })).toBeUndefined();
		expect(harness.activeTools).toEqual(["read"]);
		controller.set("read", false);
		controller.set("bash", true);
		expect(harness.entries).toEqual([
			{ customType: TOOL_SELECTION_ENTRY, data: { enabledTools: [] } },
			{ customType: TOOL_SELECTION_ENTRY, data: { enabledTools: ["bash"] } },
		]);
		controller.restore({ branchEntries: [] });
		expect(harness.activeTools).toEqual(["read"]);
	});

	it("SDK 改变工具后，列表、切换和保存读取实时状态，保存原生工具名列表", async () => {
		const harness = createHarness(["read", "bash", "web"]);
		let saved: readonly string[] | undefined;
		const controller = new ToolSelectionController(harness.port, {
			saveUserDefaults: async (tools) => { saved = tools; return "settings.json"; },
		});
		controller.restore({ branchEntries: [] });
		harness.port.setActiveTools(["bash"]);
		expect(controller.listTools().filter((tool) => tool.enabled).map((tool) => tool.name)).toEqual(["bash"]);
		controller.set("web", true);
		expect(harness.activeTools).toEqual(["bash", "web"]);
		expect(harness.entries.at(-1)?.data.enabledTools).toEqual(["bash", "web"]);
		harness.port.setActiveTools(["read"]);
		await expect(controller.persistUserDefaults()).resolves.toBe("settings.json");
		expect(saved).toEqual(["read"]);
		harness.port.setActiveTools([]);
		await controller.persistUserDefaults();
		expect(saved).toEqual([]);
	});

	it("恢复手动选择后由 SDK 发现的工具，不覆盖原生声明变更", () => {
		const harness = createHarness(["read", "bash", "search"]);
		const controller = new ToolSelectionController(harness.port);
		controller.restore({ branchEntries: [
			{ type: "custom", customType: TOOL_SELECTION_ENTRY, data: { enabledTools: ["read", "bash"] } },
			{ type: "message", message: { role: "system", toolsRemoved: [{ name: "bash" }], toolsAdded: [{ name: "search" }] } },
		] });
		expect(harness.activeTools).toEqual(["read", "search"]);
	});

	it("报告分支中已删除的工具", () => {
		const harness = createHarness(["read"]);
		const controller = new ToolSelectionController(harness.port);
		expect(controller.restore({ branchEntries: [{
			type: "custom", customType: TOOL_SELECTION_ENTRY, data: { enabledTools: ["removed"] },
		}] })).toEqual({ type: "removed-tools", toolNames: ["removed"] });
		expect(harness.activeTools).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("非 Windows 展示但无法启用 PowerShell", () => {
		const harness = createHarness(["read", "powershell"], ["read"]);
		const controller = new ToolSelectionController(harness.port);
		controller.restore({ branchEntries: [] });
		expect(controller.listTools()).toEqual([
			{ name: "read", description: "read", exposure: "direct", enabled: true, available: true },
			{ name: "powershell", description: "powershell", exposure: "direct", enabled: false, available: false },
		]);
		controller.set("powershell", true);
		expect(harness.activeTools).toEqual(["read"]);
		expect(harness.entries).toEqual([]);
	});
});

function createHarness(toolNames: string[], initialActiveTools: string[] = toolNames) {
	let activeTools = [...initialActiveTools];
	const entries: Array<{ customType: string; data: ToolSelectionEntryData }> = [];
	const port = {
		getAllTools: () => toolNames.map(makeToolInfo),
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) { activeTools = [...names]; },
		appendEntry(customType: string, data: ToolSelectionEntryData) { entries.push({ customType, data }); },
	};
	return { port, entries, get activeTools() { return activeTools; } };
}

function makeToolInfo(name: string): ToolInfo {
	return {
		name, exposure: "direct", description: name,
		parameters: { type: "object", properties: {} } as never,
		sourceInfo: { path: path.resolve("test", "extension.ts"), source: "test", scope: "temporary", origin: "top-level" },
	};
}
