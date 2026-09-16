import type { ExtensionCommandContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { extensions } from "../../harness/extensions.ts";
import stats, { collectContextStats } from "../../harness/extensions/stats.ts";
import systemPrompt from "../../harness/extensions/system-prompt.ts";
import usage from "../../harness/extensions/usage.ts";
import { registerTelemetryCommand } from "../../harness/extensions/telemetry.ts";
import { registerTelemetry } from "../../harness/telemetry/service.ts";
import { createLiveTelemetryReport } from "../../harness/telemetry-report/live.ts";
import { filterSessionTreeNoTools } from "./session-tree.ts";
import { createSubagentExtension } from "../../harness/extensions/subagent.ts";
import { createToolsExtension } from "../../harness/extensions/cmd-slash-tools.ts";
import type { Presenter } from "../../harness/presentation.ts";
import type { ToolSelectionController } from "../../harness/tool-defaults/controller.ts";
import type { GuiEvent, GuiSessionDetails } from "../contract.ts";

export type ReadSessionInfo = (ctx: ExtensionCommandContext) => Promise<GuiSessionDetails>;

export function createGuiExtensions(
	emit: (event: GuiEvent) => void,
	bindTools: (controller: ToolSelectionController) => void,
	commandSignal: () => AbortSignal,
	bindSessionInfo: (read: ReadSessionInfo) => void,
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
		{ name: "stats", factory: (pi) => stats(pi, { mode: "gui", show: async (_ctx, value) => emit({ type: "report", title: "会话统计", value }) }) },
		{ name: "system-prompt", factory: (pi) => systemPrompt(pi, panel("系统提示词")) },
		{ name: "usage", factory: (pi) => usage(pi, { mode: "gui", show: async (_ctx, value) => emit({ type: "report", title: "套餐用量", value }) }) },
		{ name: "telemetry", factory: (pi) => {
			const service = registerTelemetry(pi);
			registerTelemetryCommand(pi, service, { mode: "gui", show: async (_ctx, value) => emit({ type: "report", title: "遥测", value }) });
			bindSessionInfo(async (ctx) => {
				const sessionId = ctx.sessionManager.getSessionId();
				const tree = filterSessionTreeNoTools(ctx.sessionManager.getTree(), ctx.sessionManager.getLeafId());
				const telemetry = createLiveTelemetryReport(service.snapshot());
				return { sessionId, tree, telemetry, stats: await collectContextStats(ctx, pi) };
			});
		} },
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
