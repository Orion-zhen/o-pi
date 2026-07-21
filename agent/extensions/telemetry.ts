import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTelemetry, type TelemetryService } from "../../src/telemetry/service.js";

const COMMAND_DESCRIPTION = "Show telemetry of current session.";

/** 启用本地工具调用遥测，并注册当前 session 的只读分析视图。 */
export default function telemetryExtension(pi: ExtensionAPI): void {
	const service = registerTelemetry(pi);
	registerTelemetryCommand(pi, service);
}

export function registerTelemetryCommand(
	pi: Pick<ExtensionAPI, "registerCommand">,
	service: Pick<TelemetryService, "snapshot">,
): void {
	pi.registerCommand("telemetry", {
		description: COMMAND_DESCRIPTION,
		async handler(_args, ctx) {
			const [{ createLiveTelemetryReport }, { formatLiveTelemetrySummary }] = await Promise.all([
				import("../../src/telemetry-report/live.js"),
				import("../../src/telemetry-report/render-live.js"),
			]);
			const report = createLiveTelemetryReport(service.snapshot());
			if (ctx.mode !== "tui") {
				ctx.ui.notify(formatLiveTelemetrySummary(report), "info");
				return;
			}
			const { TelemetryViewer } = await import("../../src/telemetry-report/viewer.js");
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new TelemetryViewer(report, theme, () => tui.terminal.rows, done), {
				overlay: true,
				overlayOptions: { width: "90%", minWidth: 80 },
			});
		},
	});
}
