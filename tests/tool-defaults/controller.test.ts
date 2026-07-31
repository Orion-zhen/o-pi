import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	TOOL_SELECTION_ENTRY,
	ToolSelectionController,
	type ToolSelectionEntryData,
} from "../../src/tool-defaults/controller.js";
import type { ToolDefaultsConfig } from "../../src/tool-defaults/config.js";

describe("ToolSelectionController", () => {
	it("按 model-aware defaults 恢复，并以 JSON-safe snapshot 执行 set/toggle/reset 持久化", async () => {
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

		const restored = await controller.restore({
			cwd: "/workspace",
			branchEntries: [],
			model: { provider: "openai", id: "gpt" },
		});
		expect(restored).toMatchObject({
			status: "restored",
			source: "defaults",
			issues: [],
			snapshot: { enabledTools: ["read"], empty: false },
		});
		expect(structuredClone(restored)).toEqual(JSON.parse(JSON.stringify(restored)));

		expect(controller.set("read", false)).toMatchObject({
			status: "applied",
			operation: "set",
			code: "EMPTY_SELECTION",
			persisted: true,
			snapshot: { enabledTools: [], empty: true },
		});
		expect(controller.toggle("bash")).toMatchObject({
			status: "applied",
			operation: "toggle",
			code: "UPDATED",
			snapshot: { enabledTools: ["bash"] },
		});
		expect(harness.entries).toEqual([
			{ customType: TOOL_SELECTION_ENTRY, data: { enabledTools: [] } },
			{ customType: TOOL_SELECTION_ENTRY, data: { enabledTools: ["bash"] } },
		]);

		expect(await controller.reset({
			cwd: "/workspace",
			model: { provider: "openai", id: "gpt" },
		})).toMatchObject({
			status: "applied",
			operation: "reset",
			code: "UPDATED",
			snapshot: { enabledTools: ["read"] },
		});
	});

	it("稳定报告 branch 中已删除工具和空选择", async () => {
		const harness = createHarness(["read"]);
		const controller = new ToolSelectionController(harness.port);
		const outcome = await controller.restore({
			cwd: "/workspace",
			branchEntries: [{
				type: "custom",
				customType: TOOL_SELECTION_ENTRY,
				data: { enabledTools: ["removed"] },
			}],
			model: undefined,
		});

		expect(outcome).toEqual({
			status: "restored",
			source: "branch",
			issues: ["EMPTY_SELECTION", "REMOVED_TOOLS"],
			removedTools: ["removed"],
			snapshot: {
				tools: [{ name: "read", description: "read", enabled: false }],
				enabledTools: [],
				empty: true,
			},
		});
		expect(harness.activeTools).toEqual([]);
	});

	it("未知工具不修改 active tools 或 session entry", async () => {
		const harness = createHarness(["read"]);
		const controller = new ToolSelectionController(harness.port, {
			loadConfig: async () => ({ layers: [] }),
		});
		await controller.restore({ cwd: "/workspace", branchEntries: [], model: undefined });

		expect(controller.set("missing", false)).toMatchObject({
			status: "rejected",
			operation: "set",
			code: "UNKNOWN_TOOL",
			toolName: "missing",
		});
		expect(controller.toggle("missing")).toMatchObject({
			status: "rejected",
			operation: "toggle",
			code: "UNKNOWN_TOOL",
			toolName: "missing",
		});
		expect(harness.activeTools).toEqual(["read"]);
		expect(harness.entries).toEqual([]);
	});

	it("配置错误降级为全部启用并返回结构化错误", async () => {
		const harness = createHarness(["read", "bash"]);
		const controller = new ToolSelectionController(harness.port, {
			loadConfig: async () => {
				throw new Error("invalid tools config");
			},
		});

		const outcome = await controller.restore({
			cwd: "/workspace",
			branchEntries: [],
			model: undefined,
		});
		expect(outcome).toMatchObject({
			status: "degraded",
			source: "defaults",
			code: "CONFIG_ERROR",
			message: "invalid tools config",
			snapshot: { enabledTools: ["read", "bash"] },
		});
	});

	it("并发恢复只允许最新分支结果生效", async () => {
		const harness = createHarness(["read", "bash"]);
		let resolveConfig: ((config: ToolDefaultsConfig) => void) | undefined;
		const pendingConfig = new Promise<ToolDefaultsConfig>((resolve) => {
			resolveConfig = resolve;
		});
		const controller = new ToolSelectionController(harness.port, { loadConfig: async () => pendingConfig });

		const first = controller.restore({ cwd: "/workspace", branchEntries: [], model: undefined });
		const second = await controller.restore({
			cwd: "/workspace",
			branchEntries: [{
				type: "custom",
				customType: TOOL_SELECTION_ENTRY,
				data: { enabledTools: ["bash"] },
			}],
			model: undefined,
		});
		if (resolveConfig === undefined) throw new Error("config resolver was not initialized");
		resolveConfig({ layers: [] });

		expect(second).toMatchObject({
			status: "restored",
			source: "branch",
			snapshot: { enabledTools: ["bash"] },
		});
		expect(await first).toMatchObject({
			status: "superseded",
			snapshot: { enabledTools: ["bash"] },
		});
		expect(harness.activeTools).toEqual(["bash"]);
	});
});

function createHarness(toolNames: string[]) {
	let activeTools = [...toolNames];
	const entries: Array<{ customType: string; data: ToolSelectionEntryData }> = [];
	const port = {
		getAllTools: () => toolNames.map(makeToolInfo),
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
