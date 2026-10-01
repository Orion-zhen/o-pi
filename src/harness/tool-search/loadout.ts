import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

type Tool = Pick<ToolInfo, "name" | "exposure">;
type ToolSelection = Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;

export function isSearchableTool(tool: Pick<ToolInfo, "exposure">): boolean {
	return tool.exposure === "codemode" || tool.exposure === "deferred";
}

/** 搜索入口由模式和已注册候选派生，不保存独立开关或 MCP 连接状态。 */
export function toolSearchEnabled(tools: readonly Tool[], active: readonly string[]): boolean {
	return !active.includes("codemode")
		&& tools.some((tool) => tool.name === "tool_search" && tool.exposure !== "hidden")
		&& tools.some((tool) => isSearchableTool(tool) && !active.includes(tool.name));
}

export function syncToolSearch(pi: ToolSelection, active = pi.getActiveTools()): void {
	const names = new Set(active);
	if (toolSearchEnabled(pi.getAllTools(), active)) names.add("tool_search");
	else names.delete("tool_search");
	const current = pi.getActiveTools();
	// 集合未变时保留 SDK 声明顺序，避免重建提示词和工具前缀。
	if (names.size !== current.length || current.some((name) => !names.has(name))) pi.setActiveTools([...names]);
}
