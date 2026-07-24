import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectStatsSnapshot, type StatsPiApi } from "../../src/stats/collector.js";

const STATS_COMMAND_DESCRIPTION = "Show current session stats.";

/** 注册 /stats：TUI 只读浮层展示当前会话统计，不写入会话历史。 */
export default function statsExtension(pi: Pick<ExtensionAPI, "registerCommand"> & StatsPiApi): void {
	pi.registerCommand("stats", {
		description: STATS_COMMAND_DESCRIPTION,
		async handler(_args, ctx) {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/stats requires TUI mode", "error");
				return;
			}

			const snapshot = await collectStatsSnapshot(ctx, pi);
			const { StatsViewer } = await import("../../src/stats/stats-viewer.js");
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new StatsViewer(snapshot, theme, () => tui.terminal.rows, done), {
				overlay: true,
				overlayOptions: { width: "90%", minWidth: 80 },
			});
		},
	});
}
