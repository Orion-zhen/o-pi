import { type ExtensionCommandContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { canPresent, type Presenter } from "../presentation.ts";
import { UsageService } from "../usage/service.ts";
import { UsageRequestError, type UsageSnapshot } from "../usage/types.ts";

const COMMAND_DESCRIPTION = "Show OAuth plan usage.";
const COMMAND_USAGE = "Usage: /usage [--refresh]";

/** 注册 /usage。查询 Pi OAuth plan 的当前消耗，并以只读浮层展示。 */
export default function usageExtension(
	pi: Pick<ExtensionAPI, "registerCommand">,
	present?: Presenter<(ctx: ExtensionCommandContext, result: UsageSnapshot | "aborted") => Promise<void>>,
): void {
	const service = new UsageService();
	pi.registerCommand("usage", {
		description: COMMAND_DESCRIPTION,
		getArgumentCompletions: (prefix) => [
			{ value: "--refresh", label: "--refresh", description: "跳过缓存，刷新套餐用量" },
		].filter((item) => item.value.startsWith(prefix.trimStart())),
		async handler(args, ctx) {
			const argument = args.trim();
			if (argument !== "" && argument !== "--refresh") {
				ctx.ui.notify(COMMAND_USAGE, "warning");
				return;
			}

			let result: UsageSnapshot | "aborted";
			try {
				result = await service.load(ctx, {
					refresh: argument === "--refresh",
					signal: ctx.signal,
				});
			} catch (error) {
				if (!(error instanceof UsageRequestError) || error.code !== "aborted") throw error;
				result = "aborted";
			}

			if (present !== undefined && canPresent(ctx, present)) {
				await present.show(ctx, result);
				return;
			}

			const { renderUsage, renderUsageCancelled } = await import("../usage/presentation/render.ts");
			const lines = result === "aborted" ? renderUsageCancelled(96) : renderUsage(result, 96);
			ctx.ui.notify(lines.join("\n"), result === "aborted" ? "error" : "info");
		},
	});
}
