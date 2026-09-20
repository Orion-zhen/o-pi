import { type ExtensionCommandContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { collectStatsSnapshot, type StatsPiApi } from "../stats/collector.ts";
import { readCurrentSystemPrompt } from "../system-prompt/current.ts";
import { canPresent, type Presenter } from "../presentation.ts";

export async function collectContextStats(ctx: ExtensionCommandContext, pi: StatsPiApi) {
	const systemPrompt = await readCurrentSystemPrompt(ctx);
	return collectStatsSnapshot({
		cwd: ctx.cwd,
		model: ctx.model,
		getEntries: () => ctx.sessionManager.getEntries(),
		getBranch: () => ctx.sessionManager.getBranch(),
		isUsingSubscription: () => ctx.model !== undefined && ctx.modelRegistry.isUsingOAuth(ctx.model),
		isIdle: () => ctx.isIdle(),
		getContextUsage: () => ctx.getContextUsage(),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptOptions: () => ctx.getSystemPromptOptions(),
	}, pi);
}

const STATS_COMMAND_DESCRIPTION = "Show current session stats.";

/** 注册 /stats：TUI 只读浮层展示当前会话统计，不写入会话历史。 */
export default function statsExtension(
	pi: Pick<ExtensionAPI, "registerCommand"> & StatsPiApi,
	present?: Presenter<(ctx: ExtensionCommandContext, snapshot: Awaited<ReturnType<typeof collectStatsSnapshot>>) => Promise<void>>,
): void {
	pi.registerCommand("stats", {
		description: STATS_COMMAND_DESCRIPTION,
		async handler(_args, ctx) {
			if (present === undefined || !canPresent(ctx, present)) {
				ctx.ui.notify("/stats requires TUI mode", "error");
				return;
			}

			const snapshot = await collectContextStats(ctx, pi);
			await present.show(ctx, snapshot);
		},
	});
}
