import type { McpExposure } from "@earendil-works/pi-coding-agent";
import type { ToolSelectionItem } from "../harness/tool-defaults/controller.ts";

export interface McpConfigDocument {
	path: string;
	content: string;
}

export type GuiToolSelectionItem = ToolSelectionItem & {
	mcp?: true;
	mcpServer?: { name: string; tool: string; exposure: McpExposure };
};
