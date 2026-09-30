import type { ToolInfo } from "@earendil-works/pi-coding-agent";

/** only 模式只保留模型专用入口，GUI 与请求装配共用隐藏规则。 */
export function codemodeHiddenDeclarations(tools: readonly Pick<ToolInfo, "name" | "exposure">[]): string[] {
	return tools.filter((tool) => tool.exposure !== "model-only").map((tool) => tool.name);
}
