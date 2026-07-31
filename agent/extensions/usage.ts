import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { UsageService } from "../../src/usage/service.js";
import type { UsageSnapshot } from "../../src/usage/types.js";

const COMMAND_DESCRIPTION = "Show OAuth plan usage.";
const COMMAND_USAGE = "Usage: /usage [--refresh]";

/** 注册 /usage：查询 Pi OAuth plan 的当前消耗，并以只读浮层展示。 */
export default function usageExtension(pi: Pick<ExtensionAPI, "registerCommand">): void {
	const service = new UsageService();
	pi.registerCommand("usage", {
		description: COMMAND_DESCRIPTION,
		async handler(args, ctx) {
			const argument = args.trim();
			if (argument !== "" && argument !== "--refresh") {
				ctx.ui.notify(COMMAND_USAGE, "warning");
				return;
			}

			let result: UsageSnapshot | Error;
			try {
				result = await service.load(ctx, {
					refresh: argument === "--refresh",
					...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
				});
			} catch (error) {
				result = error instanceof Error ? error : new Error("Unknown usage error.");
			}

			if (ctx.mode === "tui") {
				const { UsageViewer } = await import("../../src/usage/tui/viewer.js");
				await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new UsageViewer(result, theme, () => tui.terminal.rows, done), {
					overlay: true,
					overlayOptions: { anchor: "center", width: "90%", minWidth: 110, margin: 1 },
				});
				return;
			}

			const { renderUsage, renderUsageError } = await import("../../src/usage/presentation/render.js");
			const lines = result instanceof Error ? renderUsageError(result, 96) : renderUsage(result, 96);
			ctx.ui.notify(lines.join("\n"), result instanceof Error ? "error" : "info");
		},
	});
}
