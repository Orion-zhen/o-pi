import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SubagentProgressCallback } from "../../../harness/subagent/types.ts";
import { renderSubagentCommandWidget } from "./renderer.ts";

let commandWidgetSequence = 0;

export interface SubagentCommandProgressAdapter {
	onProgress: SubagentProgressCallback;
	dispose(): void;
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
