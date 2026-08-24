import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	TOOL_SELECTION_ENTRY,
	ToolSelectionController,
	type ToolSelectionEntryData,
} from "../../src/tool-defaults/controller.js";
import {
	ToolDefaultsConfigError,
	type ToolDefaultsConfig,
} from "../../src/tool-defaults/config.js";

describe("ToolSelectionController", () => {
	it("按 model-aware defaults 恢复并持久化选择", async () => {
		const harness = createHarness(["read", "bash", "web"]);
		const config: ToolDefaultsConfig = {
			layers: [{
				defaults: { bash: false },
				rules: [{
					match: "openai/*",
					tools: { web: false },
					staticPrefixLength: 7,
					exact: false,
					expression: /^openai\/.*$/u,
				}],
			}],
		};
		const controller = new ToolSelectionController(harness.port, { loadConfig: async () => config });

		await expect(controller.restore({
			cwd: "/workspace",
			branchEntries: [],
			model: { provider: "openai", id: "gpt" },
			refreshConfig: false,
		})).resolves.toBeUndefined();
		expect(harness.activeTools).toEqual(["read"]);

		controller.set("read", false);
		controller.set("bash", true);
		expect(harness.activeTools).toEqual(["bash"]);
		expect(harness.entries).toEqual([
			{ customType: TOOL_SELECTION_ENTRY, data: { enabledTools: [] } },
			{ customType: TOOL_SELECTION_ENTRY, data: { enabledTools: ["bash"] } },
		]);
	});

	it("将当前完整选择保存为用户默认值", async () => {
		const harness = createHarness(["read", "bash"], ["read"]);
		let savedDefaults: Readonly<Record<string, boolean>> | undefined;
		const controller = new ToolSelectionController(harness.port, {
			loadConfig: async () => ({ layers: [] }),
			saveUserDefaults: async (defaults) => {
				savedDefaults = defaults;
				return "/home/test/.pi/agent/tools.jsonc";
			},
		});

		await controller.restore({
			cwd: "/workspace",
			branchEntries: [],
			model: undefined,
			refreshConfig: false,
		});
		await expect(controller.persistUserDefaults()).resolves.toBe("/home/test/.pi/agent/tools.jsonc");
		expect(savedDefaults).toEqual({ read: true, bash: false });
		expect(harness.entries).toEqual([]);
	});

	it("报告 branch 中已删除的工具", async () => {
		const harness = createHarness(["read"]);
		const controller = new ToolSelectionController(harness.port);

		await expect(controller.restore({
			cwd: "/workspace",
			branchEntries: [{
				type: "custom",
				customType: TOOL_SELECTION_ENTRY,
				data: { enabledTools: ["removed"] },
			}],
			model: undefined,
			refreshConfig: false,
		})).resolves.toEqual({ type: "removed-tools", toolNames: ["removed"] });
		expect(harness.activeTools).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("非 Windows 展示但无法启用 PowerShell", async () => {
		const harness = createHarness(["read", "powershell"], ["read"]);
		const controller = new ToolSelectionController(harness.port, {
			loadConfig: async () => ({ layers: [{ defaults: { powershell: true }, rules: [] }] }),
		});

		await controller.restore({
			cwd: "/workspace",
			branchEntries: [],
			model: undefined,
			refreshConfig: false,
		});

		expect(controller.listTools()).toEqual([
			{ name: "read", description: "read", enabled: true, available: true },
			{ name: "powershell", description: "powershell", enabled: false, available: false },
		]);
		controller.set("powershell", true);
		expect(harness.activeTools).toEqual(["read"]);
		expect(harness.entries).toEqual([]);
	});

	it("未显式配置的新工具保持宿主初始禁用状态", async () => {
		const harness = createHarness(["read", "future-tool"], ["read"]);
		const controller = new ToolSelectionController(harness.port, {
			loadConfig: async () => ({ layers: [] }),
		});

		await controller.restore({
			cwd: "/workspace",
			branchEntries: [],
			model: undefined,
			refreshConfig: false,
		});

		expect(harness.activeTools).toEqual(["read"]);
	});

	it("配置错误恢复宿主初始工具并返回通知", async () => {
		const harness = createHarness(["read", "bash"], ["read"]);
		const controller = new ToolSelectionController(harness.port, {
			loadConfig: async () => {
				throw new ToolDefaultsConfigError("invalid tools config");
			},
		});

		await expect(controller.restore({
			cwd: "/workspace",
			branchEntries: [],
			model: undefined,
			refreshConfig: false,
		})).resolves.toEqual({ type: "config-error", message: "invalid tools config" });
		expect(harness.activeTools).toEqual(["read"]);
	});

	it("非配置异常正常传播", async () => {
		const controller = new ToolSelectionController(createHarness(["read"]).port, {
			loadConfig: async () => {
				throw new Error("unexpected failure");
			},
		});

		await expect(controller.restore({
			cwd: "/workspace",
			branchEntries: [],
			model: undefined,
			refreshConfig: false,
		})).rejects.toThrow("unexpected failure");
	});

	it("并发恢复只允许最新分支结果生效", async () => {
		const harness = createHarness(["read", "bash"]);
		let resolveConfig: ((config: ToolDefaultsConfig) => void) | undefined;
		const pendingConfig = new Promise<ToolDefaultsConfig>((resolve) => {
			resolveConfig = resolve;
		});
		const controller = new ToolSelectionController(harness.port, { loadConfig: async () => pendingConfig });

		const first = controller.restore({
			cwd: "/workspace",
			branchEntries: [],
			model: undefined,
			refreshConfig: false,
		});
		await controller.restore({
			cwd: "/workspace",
			branchEntries: [{
				type: "custom",
				customType: TOOL_SELECTION_ENTRY,
				data: { enabledTools: ["bash"] },
			}],
			model: undefined,
			refreshConfig: false,
		});
		if (resolveConfig === undefined) throw new Error("config resolver was not initialized");
		resolveConfig({ layers: [] });
		await first;

		expect(harness.activeTools).toEqual(["bash"]);
	});
});

function createHarness(toolNames: string[], initialActiveTools: string[] = toolNames) {
	let activeTools = [...initialActiveTools];
	const entries: Array<{ customType: string; data: ToolSelectionEntryData }> = [];
	const port = {
		getAllTools: () => toolNames.map(makeToolInfo),
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		appendEntry(customType: string, data: ToolSelectionEntryData) {
			entries.push({ customType, data });
		},
	};
	return {
		port,
		entries,
		get activeTools() {
			return activeTools;
		},
	};
}

function makeToolInfo(name: string): ToolInfo {
	return {
		name,
		description: name,
		parameters: { type: "object", properties: {} } as never,
		sourceInfo: {
			path: path.resolve("test", "extension.ts"),
			source: "test",
			scope: "temporary",
			origin: "top-level",
		},
	};
}
