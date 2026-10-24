import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ToolSelectionController, ToolSelectionItem } from "./controller.ts";
import { TOOL_PRESETS, type ToolPreset } from "./types.ts";

type ToolPresets = Record<ToolPreset, string[]>;
const webTools = new Set(["websearch", "webfetch"]);

function resolveToolPresets(session: AgentSession, builtin: readonly ToolSelectionItem[]): ToolPresets {
	const available = builtin.filter((tool) => tool.available && tool.name !== "tool_search");
	// 从注册定义恢复出厂选择，不读取用户默认值或当前会话的启用集合。
	const vanilla = available.filter((tool) => {
		const definition = session.extensionRunner.getToolDefinition(tool.name);
		return definition?.defaultActive !== false && (tool.exposure === "direct" || tool.exposure === "model-only");
	}).map((tool) => tool.name);
	return {
		vanilla,
		"web-chat": available.filter((tool) => webTools.has(tool.name)).map((tool) => tool.name),
		offline: vanilla.filter((name) => !webTools.has(name)),
		"no-tools": [],
	};
}

export function matchingToolPreset(session: AgentSession, builtin: readonly ToolSelectionItem[]): ToolPreset | null {
	const presets = resolveToolPresets(session, builtin);
	const tools = builtin.filter((tool) => tool.name !== "tool_search");
	return TOOL_PRESETS.find((preset) => {
		const names = new Set(presets[preset]);
		return tools.every((tool) => tool.enabled === names.has(tool.name));
	}) ?? null;
}

/** 只替换内置工具选择，MCP 工具保持原状，搜索入口由控制器同步。 */
export function applyToolPreset(session: AgentSession, selection: ToolSelectionController, preset: ToolPreset, mcpNames: ReadonlySet<string>): void {
	const builtin = selection.listTools().filter((tool) => !mcpNames.has(tool.name));
	const names = new Set(resolveToolPresets(session, builtin)[preset]);
	selection.setMany(builtin.map((tool) => ({ name: tool.name, enabled: names.has(tool.name) })));
}
