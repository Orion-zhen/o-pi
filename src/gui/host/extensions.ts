import type { ExtensionCommandContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { extensions } from "../../harness/extensions.ts";
import stats from "../../harness/extensions/stats.ts";
import systemPrompt from "../../harness/extensions/system-prompt.ts";
import usage from "../../harness/extensions/usage.ts";
import telemetry from "../../harness/extensions/telemetry.ts";
import { createSubagentExtension } from "../../harness/extensions/subagent.ts";
import { createToolsExtension } from "../../harness/extensions/cmd-slash-tools.ts";
import type { Presenter } from "../../harness/presentation.ts";
import type { ToolSelectionController } from "../../harness/tool-defaults/controller.ts";
import type { GuiEvent } from "../contract.ts";

export function createGuiExtensions(
	emit: (event: GuiEvent) => void,
	bindTools: (controller: ToolSelectionController) => void,
	commandSignal: () => AbortSignal,
): InlineExtension[] {
	const panel = (title: string): Presenter<(_ctx: ExtensionCommandContext, value: unknown) => Promise<void>> => ({
		mode: "gui",
		show: async (_ctx, value) => {
			emit({ type: "panel", title, value });
		},
	});
	const views: InlineExtension[] = [
		{
			name: "subagent",
			factory: createSubagentExtension(undefined, {
				signal: commandSignal,
				onProgress: (value) => emit({ type: "panel", title: "子代理任务", value }),
				present: (value) => emit({ type: "panel", title: "子代理任务", value }),
			}),
		},
		{ name: "stats", factory: (pi) => stats(pi, panel("会话统计")) },
		{ name: "system-prompt", factory: (pi) => systemPrompt(pi, panel("系统提示词")) },
		{ name: "usage", factory: (pi) => usage(pi, panel("套餐用量")) },
		{ name: "telemetry", factory: (pi) => telemetry(pi, panel("遥测")) },
		{
			name: "cmd-slash-tools",
			factory: createToolsExtension(undefined, {
				mode: "gui",
				show: (controller) => {
					bindTools(controller);
					emit({ type: "panel", title: "工具选择", value: controller.listTools() });
				},
			}),
		},
	];
	return extensions.map((extension) => views.find((view) => view.name === extension.name) ?? extension);
}
