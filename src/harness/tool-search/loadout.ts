import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export function isSearchableTool(tool: Pick<ToolInfo, "exposure">): boolean {
	return tool.exposure === "codemode" || tool.exposure === "deferred";
}

export function hasSearchableTools(tools: readonly Pick<ToolInfo, "name" | "exposure">[], active: readonly string[]): boolean {
	return tools.some((tool) => isSearchableTool(tool) && !active.includes(tool.name));
}
