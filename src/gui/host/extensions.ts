import type { ExtensionCommandContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { extensions } from "../../harness/extensions.ts";
import { collectContextStats } from "../../harness/extensions/stats.ts";
import systemPrompt from "../../harness/extensions/system-prompt.ts";
import usage from "../../harness/extensions/usage.ts";
import { registerTelemetry } from "../../harness/telemetry/service.ts";
import { createLiveTelemetryReport } from "../../harness/telemetry-report/live.ts";
import { filterSessionTreeNoTools } from "./session-tree.ts";
import { createSubagentExtension } from "../../harness/extensions/subagent.ts";
import { createToolsExtension } from "../../harness/extensions/cmd-slash-tools.ts";
import type { ToolSelectionController } from "../../harness/tool-defaults/controller.ts";
import type { GuiDialogs } from "./dialogs.ts";
import approvalGate from "../../harness/extensions/approval-gate.ts";
import type { GuiEvent, GuiSessionDetails } from "../contract.ts";

export type ReadSessionInfo = (ctx: ExtensionCommandContext) => Promise<GuiSessionDetails>;
export interface GuiExtensionBindings {
	dialogs: GuiDialogs;
	emit(event: GuiEvent): void;
	bindTools(controller: ToolSelectionController): void;
	commandSignal(): AbortSignal;
	bindSessionInfo(read: ReadSessionInfo): void;
}

export function createGuiExtensions({ dialogs, emit, bindTools, commandSignal, bindSessionInfo }: GuiExtensionBindings): InlineExtension[] {
	const views: InlineExtension[] = [
		{ name: "approval-gate", factory: (pi) => approvalGate(pi, { mode: "gui", show: (_ui, ...args) => dialogs.approve(...args) }) },
		{
			name: "subagent",
			factory: createSubagentExtension(undefined, {
				signal: commandSignal,
				onProgress: ({ result }) => emit({ type: "panel", panel: { kind: "subagents", details: result.details } }),
				present: (result) => emit({ type: "panel", panel: { kind: "subagents", details: result.details } }),
			}),
		},
		{
			name: "stats",
			factory: (pi) => pi.registerCommand("stats", {
				description: "Show current session stats.",
				handler: async () => emit({ type: "sessionTab", tab: "stats" }),
			}),
		},
		{
			name: "system-prompt",
			factory: (pi) => systemPrompt(pi, {
				mode: "gui", show: async (_ctx, text) => emit({ type: "panel", panel: { kind: "system", text } }),
			}),
		},
		{
			name: "usage",
			factory: (pi) => usage(pi, {
				mode: "gui", show: async (_ctx, value) => emit({ type: "panel", panel: { kind: "usage", value } }),
			}),
		},
		{
			name: "telemetry",
			factory: (pi) => {
				const service = registerTelemetry(pi);
				pi.registerCommand("telemetry", {
					description: "Show telemetry of current session.",
					handler: async () => emit({ type: "sessionTab", tab: "telemetry" }),
				});
				bindSessionInfo(async (ctx) => ({
					sessionId: ctx.sessionManager.getSessionId(),
					tree: filterSessionTreeNoTools(ctx.sessionManager.getTree(), ctx.sessionManager.getLeafId()),
					telemetry: createLiveTelemetryReport(service.snapshot()),
					stats: await collectContextStats(ctx, pi),
				}));
			},
		},
		{
			name: "cmd-slash-tools",
			factory: createToolsExtension(undefined, {
				mode: "gui", show: () => emit({ type: "panel", panel: { kind: "tools" } }),
			}, bindTools),
		},
	];
	return extensions.map((extension) => views.find((view) => view.name === extension.name) ?? extension);
}
