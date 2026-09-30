import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import type { ToolSelectionItem } from "../../../../src/harness/tool-defaults/controller.ts";
import { ToolSelectorComponent } from "../../../../src/tui/views/tool-defaults/tool-selector.ts";

const theme: Pick<Theme, "bold" | "fg"> = {
	bold: (text) => text,
	fg: (_color, text) => text,
};

describe("ToolSelectorComponent", () => {
	it("支持搜索、逐项切换、会话回调和退出", () => {
		const changes: Array<{ name: string; enabled: boolean }> = [];
		let cancelled = false;
		const tools: ToolSelectionItem[] = [
			{ name: "read", description: "Read files", exposure: "direct", enabled: true, available: true },
			{ name: "bash", description: "Run commands", exposure: "direct", enabled: false, available: true },
		];
		const component = new ToolSelectorComponent(tools, theme, {
			onChange: (name, enabled) => {
				changes.push({ name, enabled });
				return tools.map((tool) => tool.name === name ? { ...tool, available: true, enabled } : tool);
			},
			onPersist: async () => true,
			onCancel: () => {
				cancelled = true;
			},
			requestRender: () => {},
		});

		for (const character of "bash") component.handleInput(character);
		component.handleInput("\r");
		component.handleInput("\u001b");

		expect(changes).toEqual([{ name: "bash", enabled: true }]);
		expect(cancelled).toBe(true);
	});

	it("窄终端中不会产生超宽行", () => {
		const tools: ToolSelectionItem[] = [
			{ name: "a-very-long-tool-name", description: "A long tool description", exposure: "direct", enabled: false, available: true },
		];
		const component = new ToolSelectorComponent(tools, theme, {
			onChange: () => tools,
			onPersist: async () => true,
			onCancel: () => {},
			requestRender: () => {},
		});

		expect(component.render(24).every((line) => visibleWidth(line) <= 24)).toBe(true);
	});

	it("不可用工具无法切换", () => {
		const onChange = vi.fn();
		const tools: ToolSelectionItem[] = [
			{ name: "powershell", description: "Run PowerShell commands", exposure: "direct", enabled: false, available: false },
		];
		const component = new ToolSelectorComponent(tools, theme, {
			onChange,
			onPersist: async () => true,
			onCancel: () => {},
			requestRender: () => {},
		});

		component.handleInput("\r");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("切换候选工具后刷新搜索入口的可用性", () => {
		const tools: ToolSelectionItem[] = [
			{ name: "fixture", description: "Fixture", exposure: "deferred", enabled: false, available: true },
			{ name: "tool_search", description: "Search", exposure: "model-only", enabled: true, available: true },
		];
		const onChange = vi.fn((): ToolSelectionItem[] => [
			{ name: "fixture", description: "Fixture", exposure: "deferred", enabled: true, available: true },
			{ name: "tool_search", description: "Search", exposure: "model-only", enabled: false, available: false },
		]);
		const component = new ToolSelectorComponent(tools, theme, {
			onChange, onPersist: async () => true, onCancel: () => {}, requestRender: () => {},
		});
		component.handleInput("\r");
		component.handleInput("\u001b[B");
		component.handleInput("\r");
		expect(onChange).toHaveBeenCalledExactlyOnceWith("fixture", true);
		expect(component.render(100).find((line) => line.includes("tool_search"))).toContain("(unavailable)");
	});

	it("保存进行中忽略重复请求，失败后允许重试", async () => {
		let resolveFirst: ((saved: boolean) => void) | undefined;
		const firstSave = new Promise<boolean>((resolve) => {
			resolveFirst = resolve;
		});
		let attempts = 0;
		const requestRender = vi.fn();
		const tools: ToolSelectionItem[] = [
			{ name: "read", description: "Read files", exposure: "direct", enabled: true, available: true },
		];
		const component = new ToolSelectorComponent(tools, theme, {
			onChange: () => tools,
			onPersist: async () => {
				attempts += 1;
				return attempts === 1 ? firstSave : true;
			},
			onCancel: () => {},
			requestRender,
		});

		component.handleInput("\u0013");
		component.handleInput("\u0013");
		expect(attempts).toBe(1);
		if (resolveFirst === undefined) throw new Error("save resolver was not initialized");
		resolveFirst(false);
		await vi.waitFor(() => expect(requestRender).toHaveBeenCalledOnce());
		component.handleInput("\u0013");
		expect(attempts).toBe(2);
	});

	it("仅在 Ctrl+S 时调用用户默认值保存回调", async () => {
		let persistCount = 0;
		let cancelled = false;
		const requestRender = vi.fn();
		const tools: ToolSelectionItem[] = [
			{ name: "read", description: "Read files", exposure: "direct", enabled: true, available: true },
		];
		const component = new ToolSelectorComponent(tools, theme, {
			onChange: () => tools,
			onPersist: async () => {
				persistCount += 1;
				return true;
			},
			onCancel: () => {
				cancelled = true;
			},
			requestRender,
		});

		component.handleInput("\r");
		component.handleInput("\u001b");
		expect(persistCount).toBe(0);
		expect(cancelled).toBe(true);

		component.handleInput("\u0013");
		await vi.waitFor(() => {
			expect(persistCount).toBe(1);
			expect(requestRender).toHaveBeenCalled();
		});
	});
});
