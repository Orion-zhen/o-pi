import type { ExtensionCommandContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { extensions as harnessExtensions } from "../harness/extensions.js";
import approvalGate from "../harness/extensions/approval-gate.js";
import bashTool from "../harness/extensions/bash-tool.js";
import { createToolsExtension } from "../harness/extensions/cmd-slash-tools.js";
import { createFileToolsExtension } from "../harness/extensions/file-tools.js";
import { createPruneExtension } from "../harness/extensions/prune.js";
import { createSkillContextExtension } from "../harness/extensions/skill-context.js";
import stats from "../harness/extensions/stats.js";
import { createSubagentExtension } from "../harness/extensions/subagent.js";
import systemPrompt from "../harness/extensions/system-prompt.js";
import telemetry from "../harness/extensions/telemetry.js";
import usage from "../harness/extensions/usage.js";
import { createWebToolsExtension } from "../harness/extensions/web-tools.js";
import type { StatsSnapshot } from "../harness/stats/types.js";
import type { LiveTelemetryReport } from "../harness/telemetry-report/live.js";
import type { UsageSnapshot } from "../harness/usage/types.js";
import tui from "./shell/extension.js";

/** 终端入口装配呈现器，harness 不知道组件的路径和加载方式。 */
export const presentation = {
	fileTools: { renderers: () => import("./chat/file-tools/index.js") },
	bashTool: () => import("./chat/bash-tool/renderer.js"),
	tools: () => import("./views/tool-defaults/tool-selector.js"),
	prune: () => import("./chat/prune/index.js"),
	skillContext: () => import("./chat/skill-context/renderer.js"),
	subagent: () => import("./chat/subagent/adapter.js"),
	webTools: async () => {
		const [fetch, search] = await Promise.all([
			import("./chat/web-tools/webfetch.js"),
			import("./chat/web-tools/websearch.js"),
		]);
		return { ...fetch, ...search };
	},
	approvalGate: async (...args: Parameters<(typeof import("./views/approval/dialog.js"))["openApprovalDialog"]>) =>
		(await import("./views/approval/dialog.js")).openApprovalDialog(...args),
	stats: async (ctx: ExtensionCommandContext, snapshot: StatsSnapshot) => {
		const { StatsViewer } = await import("./views/stats/stats-viewer.js");
		await ctx.ui.custom<void>(
			(tui, theme, _keys, done) => new StatsViewer(snapshot, theme, () => tui.terminal.rows, done),
			{
				overlay: true,
				overlayOptions: { width: "90%", minWidth: 80 },
			},
		);
	},
	usage: async (ctx: ExtensionCommandContext, snapshot: UsageSnapshot | "aborted") => {
		const { UsageViewer } = await import("./views/usage/viewer.js");
		await ctx.ui.custom<void>(
			(tui, theme, _keys, done) => new UsageViewer(snapshot, theme, () => tui.terminal.rows, done),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "90%", minWidth: 110, margin: 1 },
			},
		);
	},
	systemPrompt: async (ctx: ExtensionCommandContext, prompt: string) => {
		const { SystemPromptViewer } = await import("./views/system-prompt/viewer.js");
		const model = ctx.model;
		const scope = model === undefined ? {} : { provider: model.provider, modelId: model.id, baseUrl: model.baseUrl };
		await ctx.ui.custom<void>(
			(tui, theme, _keys, done) => new SystemPromptViewer(prompt, theme, () => tui.terminal.rows, done, scope),
			{
				overlay: true,
				overlayOptions: { width: "90%", minWidth: 80 },
			},
		);
	},
	telemetry: async (ctx: ExtensionCommandContext, report: LiveTelemetryReport) => {
		const { TelemetryViewer } = await import("./views/telemetry-report/viewer.js");
		await ctx.ui.custom<void>(
			(tui, theme, _keys, done) => new TelemetryViewer(report, theme, () => tui.terminal.rows, done),
			{
				overlay: true,
				overlayOptions: { width: "90%", minWidth: 80 },
			},
		);
	},
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
