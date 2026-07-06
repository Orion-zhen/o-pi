import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectCodexResetCardSnapshot } from "../../src/codex-reset-card/client.js";
import { renderCodexResetCardError, renderCodexResetCards } from "../../src/codex-reset-card/render.js";
import { CodexResetCardViewer } from "../../src/codex-reset-card/viewer.js";

const CODEX_RESET_CARD_COMMAND_DESCRIPTION = "Show Codex reset cards.";

/** 注册 /codex-reset-card：查询 Codex 重置卡并只输出到 UI，不进入模型上下文。 */
export default function codexResetCardExtension(pi: Pick<ExtensionAPI, "registerCommand">): void {
	pi.registerCommand("codex-reset-card", {
		description: CODEX_RESET_CARD_COMMAND_DESCRIPTION,
		async handler(_args, ctx) {
			let result: Awaited<ReturnType<typeof collectCodexResetCardSnapshot>> | Error;
			try {
				result = await collectCodexResetCardSnapshot(ctx.signal ? { signal: ctx.signal } : {});
			} catch (error) {
				result = error instanceof Error ? error : new Error("Unknown reset card error.");
			}

			if (ctx.mode === "tui") {
				await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new CodexResetCardViewer(result, theme, () => tui.terminal.rows, done), {
					overlay: true,
					overlayOptions: { anchor: "center", width: 86, maxHeight: 14, margin: 1 },
				});
				return;
			}

			const lines = result instanceof Error ? renderCodexResetCardError(result, 96) : renderCodexResetCards(result, 96);
			ctx.ui.notify(lines.join("\n"), result instanceof Error ? "error" : "info");
		},
	});
}
