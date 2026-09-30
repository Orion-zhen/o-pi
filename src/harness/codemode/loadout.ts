import type { ToolInfo } from "@earendil-works/pi-coding-agent";

/** only 模式保留模型专用入口，但隐藏重复的工具发现入口。GUI 与请求装配共用此规则。 */
export function codemodeHiddenDeclarations(tools: readonly Pick<ToolInfo, "name" | "exposure">[]): string[] {
	return tools.filter((tool) => tool.exposure !== "model-only" || tool.name === "tool_search").map((tool) => tool.name);
}
