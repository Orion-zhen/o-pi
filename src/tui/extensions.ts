import type { ExtensionCommandContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { extensions as harnessExtensions } from "../harness/extensions.ts";
import approvalGate from "../harness/extensions/approval-gate.ts";
import bashTool from "../harness/extensions/bash-tool.ts";
import { createToolsExtension } from "../harness/extensions/cmd-slash-tools.ts";
import { createFileToolsExtension } from "../harness/extensions/file-tools.ts";
import { createPruneExtension } from "../harness/extensions/prune.ts";
import { createSkillContextExtension } from "../harness/extensions/skill-context.ts";
import stats from "../harness/extensions/stats.ts";
import { createSubagentExtension } from "../harness/extensions/subagent.ts";
import systemPrompt from "../harness/extensions/system-prompt.ts";
import telemetry from "../harness/extensions/telemetry.ts";
import usage from "../harness/extensions/usage.ts";
import { createWebToolsExtension } from "../harness/extensions/web-tools.ts";
import type { Presenter } from "../harness/presentation.ts";
import type { StatsSnapshot } from "../harness/stats/types.ts";
import type { LiveTelemetryReport } from "../harness/telemetry-report/live.ts";
import type { UsageSnapshot } from "../harness/usage/types.ts";
import tui from "./shell/extension.ts";

function tuiPresenter<T>(show: T): Presenter<T> { return { mode: "tui", show }; }

/** 终端入口装配呈现器，harness 不知道组件的路径和加载方式。 */
export const presentation = {
	fileTools: { renderers: () => import("./chat/file-tools/index.ts") },
	bashTool: () => import("./chat/bash-tool/renderer.ts"),
	tools: () => import("./views/tool-defaults/tool-selector.ts"),
	prune: () => import("./chat/prune/index.ts"),
	skillContext: () => import("./chat/skill-context/renderer.ts"),
	subagent: () => import("./chat/subagent/adapter.ts"),
	webTools: async () => {
		const [fetch, search] = await Promise.all([
			import("./chat/web-tools/webfetch.ts"),
			import("./chat/web-tools/websearch.ts"),
		]);
		return { ...fetch, ...search };
	},
	approvalGate: async (...args: Parameters<(typeof import("./views/approval/dialog.ts"))["openApprovalDialog"]>) =>
		(await import("./views/approval/dialog.ts")).openApprovalDialog(...args),
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

export function createTuiExtensions(): InlineExtension[] {
	const views: InlineExtension[] = [
		{ name: "approval-gate", factory: (pi) => approvalGate(pi, presentation.approvalGate) },
		{ name: "bash-tool", factory: (pi) => bashTool(pi, presentation.bashTool) },
		{ name: "cmd-slash-tools", factory: createToolsExtension(presentation.tools) },
		{ name: "file-tools", factory: createFileToolsExtension(presentation.fileTools) },
		{ name: "prune", factory: createPruneExtension(presentation.prune) },
		{ name: "skill-context", factory: createSkillContextExtension(presentation.skillContext) },
		{ name: "stats", factory: (pi) => stats(pi, presentation.stats) },
		{ name: "subagent", factory: createSubagentExtension(presentation.subagent) },
		{ name: "system-prompt", factory: (pi) => systemPrompt(pi, presentation.systemPrompt) },
		{ name: "telemetry", factory: (pi) => telemetry(pi, presentation.telemetry) },
		{ name: "usage", factory: (pi) => usage(pi, presentation.usage) },
		{ name: "web-tools", factory: createWebToolsExtension(undefined, presentation.webTools) },
	];
	const extensions = harnessExtensions.map(
		(extension) => views.find((view) => view.name === extension.name) ?? extension,
	);
	extensions.splice(
		extensions.findIndex((extension) => extension.name === "usage"),
		0,
		{ name: "tui", factory: tui },
	);
	return extensions;
}
