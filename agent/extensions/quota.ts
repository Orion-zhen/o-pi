import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectCodexQuotaSnapshot } from "../../src/codex-quota/client.js";
import { renderCodexQuota, renderCodexQuotaError } from "../../src/codex-quota/render.js";
import { CodexQuotaViewer } from "../../src/codex-quota/viewer.js";

const COMMAND_DESCRIPTION = "Show Codex quota and reset credits.";

/** 注册 /quota：通过 codex app-server 查询额度，并在 TUI 中显示只读浮层。 */
export default function quotaExtension(pi: Pick<ExtensionAPI, "registerCommand">): void {
	pi.registerCommand("quota", {
		description: COMMAND_DESCRIPTION,
		async handler(_args, ctx) {
			let result: Awaited<ReturnType<typeof collectCodexQuotaSnapshot>> | Error;
			try {
				result = await collectCodexQuotaSnapshot(ctx.signal ? { signal: ctx.signal } : {});
			} catch (error) {
				result = error instanceof Error ? error : new Error("Unknown quota error.");
			}

			if (ctx.mode === "tui") {
				await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new CodexQuotaViewer(result, theme, () => tui.terminal.rows, done), {
					overlay: true,
					overlayOptions: { anchor: "center", width: "90%", minWidth: 110, margin: 1 },
				});
				return;
			}

			const lines = result instanceof Error ? renderCodexQuotaError(result, 96) : renderCodexQuota(result, 96);
			ctx.ui.notify(lines.join("\n"), result instanceof Error ? "error" : "info");
		},
	});
}
