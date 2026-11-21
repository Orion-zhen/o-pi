import type { ToolInfo } from "@earendil-works/pi-coding-agent";

type Tool = Pick<ToolInfo, "name" | "exposure">;

export function isSearchableTool(tool: Pick<ToolInfo, "exposure">): boolean {
	return tool.exposure === "codemode" || tool.exposure === "deferred";
}

export function needsToolSearch(tools: readonly Tool[], active: ReadonlySet<string>): boolean {
	return !active.has("codemode")
		&& tools.some((tool) => isSearchableTool(tool) && !active.has(tool.name));
}
