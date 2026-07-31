import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import { SUBAGENT_COMMAND_ENTRY } from "../constants.js";
import type { SubagentProgressCallback } from "../types.js";
import {
	renderSubagentCall,
	renderSubagentCommandEntry,
	renderSubagentCommandWidget,
	renderSubagentResult,
} from "./renderer.js";

let commandWidgetSequence = 0;

export interface SubagentCommandProgressAdapter {
	onProgress: SubagentProgressCallback;
	dispose(): void;
}

export function registerSubagentTui<TParams extends TSchema, TDetails, TState>(
	pi: ExtensionAPI,
	tool: ToolDefinition<TParams, TDetails, TState>,
): void {
	pi.registerTool({ ...tool, renderCall: renderSubagentCall, renderResult: renderSubagentResult });
	pi.registerEntryRenderer(SUBAGENT_COMMAND_ENTRY, (entry, { expanded }, theme) => (
		renderSubagentCommandEntry(entry.data, expanded, theme)
	));
}

/** 把结构化进度消费为临时 widget；application promise 与此 adapter 无关。 */
export function createSubagentCommandProgressAdapter(
	ui: Pick<ExtensionCommandContext["ui"], "getToolsExpanded" | "setWidget">,
): SubagentCommandProgressAdapter {
	const widgetKey = `subagent-command-${++commandWidgetSequence}`;
	return {
		onProgress(event) {
			if (event.phase === "completed") return;
			ui.setWidget(widgetKey, (_tui, theme) => renderSubagentCommandWidget(event.result, {
				expanded: ui.getToolsExpanded(),
				isPartial: true,
			}, theme));
		},
		dispose() {
			ui.setWidget(widgetKey, undefined);
		},
	};
}
