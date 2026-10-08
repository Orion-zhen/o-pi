import type { ExtensionCommandContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { extensions as harnessExtensions } from "../harness/extensions.ts";
import approvalGate from "../harness/extensions/approval-gate.ts";
import { createToolsExtension } from "../harness/extensions/cmd-slash-tools.ts";
import { createPruneExtension } from "../harness/extensions/prune.ts";
import stats from "../harness/extensions/stats.ts";
import { createSubagentExtension } from "../harness/extensions/subagent.ts";
import systemPrompt from "../harness/extensions/system-prompt.ts";
import telemetry from "../harness/extensions/telemetry.ts";
import usage from "../harness/extensions/usage.ts";
import type { Presenter } from "../harness/presentation.ts";
import type { StatsSnapshot } from "../harness/stats/types.ts";
import type { LiveTelemetryReport } from "../harness/telemetry-report/live.ts";
import type { UsageSnapshot } from "../harness/usage/types.ts";
import tui from "./shell/extension.ts";
import type { ToolStartupOptions } from "../harness/tool-defaults/initial.ts";

function tuiPresenter<T>(show: T): Presenter<T> { return { mode: "tui", show }; }

/** 终端入口装配呈现器，harness 不知道组件的路径和加载方式。 */
export const presentation = {
	tools: () => import("./views/tool-defaults/tool-selector.ts"),
	prune: () => import("./chat/prune/index.ts"),
	subagent: () => import("./chat/subagent/adapter.ts"),
	approvalGate: tuiPresenter(async (...args: Parameters<(typeof import("./views/approval/dialog.ts"))["openApprovalDialog"]>) =>
		(await import("./views/approval/dialog.ts")).openApprovalDialog(...args)),
	stats: tuiPresenter(async (ctx: ExtensionCommandContext, snapshot: StatsSnapshot) => {
		const { StatsViewer } = await import("./views/stats/stats-viewer.ts");
		await ctx.ui.custom<void>(
			(tui, theme, _keys, done) => new StatsViewer(snapshot, theme, () => tui.terminal.rows, done),
			{
				overlay: true,
				overlayOptions: { width: "90%", minWidth: 80 },
			},
		);
	}),
	usage: tuiPresenter(async (ctx: ExtensionCommandContext, snapshot: UsageSnapshot | "aborted") => {
		const { UsageViewer } = await import("./views/usage/viewer.ts");
		await ctx.ui.custom<void>(
			(tui, theme, _keys, done) => new UsageViewer(snapshot, theme, () => tui.terminal.rows, done),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "90%", minWidth: 110, margin: 1 },
			},
		);
	}),
	systemPrompt: tuiPresenter(async (ctx: ExtensionCommandContext, prompt: string) => {
		const { SystemPromptViewer } = await import("./views/system-prompt/viewer.ts");
		const model = ctx.model;
		const scope = model === undefined ? {} : { provider: model.provider, modelId: model.id, baseUrl: model.baseUrl };
		await ctx.ui.custom<void>(
			(tui, theme, _keys, done) => new SystemPromptViewer(prompt, theme, () => tui.terminal.rows, done, scope),
			{
				overlay: true,
				overlayOptions: { width: "90%", minWidth: 80 },
			},
		);
	}),
	telemetry: tuiPresenter(async (ctx: ExtensionCommandContext, report: LiveTelemetryReport) => {
		const { TelemetryViewer } = await import("./views/telemetry-report/viewer.ts");
		await ctx.ui.custom<void>(
			(tui, theme, _keys, done) => new TelemetryViewer(report, theme, () => tui.terminal.rows, done),
			{
				overlay: true,
				overlayOptions: { width: "90%", minWidth: 80 },
			},
		);
	}),
};

export function createTuiExtensions(startup: ToolStartupOptions = {}): InlineExtension[] {
	const views: InlineExtension[] = [
		{ name: "approval-gate", factory: (pi) => approvalGate(pi, presentation.approvalGate) },
		{ name: "cmd-slash-tools", factory: createToolsExtension(presentation.tools, undefined, undefined, startup) },
		{ name: "prune", factory: createPruneExtension(presentation.prune) },
		{ name: "stats", factory: (pi) => stats(pi, presentation.stats) },
		{ name: "subagent", factory: createSubagentExtension(presentation.subagent) },
		{ name: "system-prompt", factory: (pi) => systemPrompt(pi, presentation.systemPrompt) },
		{ name: "telemetry", factory: (pi) => telemetry(pi, presentation.telemetry) },
		{ name: "usage", factory: (pi) => usage(pi, presentation.usage) },
	];
	const extensions = harnessExtensions.map(
		(extension) => views.find((view) => view.name === extension.name) ?? extension,
	);
	extensions.splice(
		extensions.findIndex((extension) => extension.name === "usage"),
		0,
		{ name: "tool-renderers", factory: (pi) => {
			let loaded: Promise<void> | undefined;
			pi.on("session_start", async (_event, ctx) => {
				if (ctx.mode !== "tui") return;
				loaded ??= import("./chat/tool-renderers.ts").then(({ registerToolRenderers }) => registerToolRenderers(pi));
				await loaded;
			});
		} },
		{ name: "tui", factory: tui },
	);
	return extensions;
}
