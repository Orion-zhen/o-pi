import { type ExtensionCommandContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type createLiveTelemetryReport } from "../telemetry-report/live.js";
type TelemetryPresenter = (
	ctx: ExtensionCommandContext,
	report: ReturnType<typeof createLiveTelemetryReport>,
) => Promise<void>;

import { registerTelemetry, type TelemetryService } from "../telemetry/service.js";

const COMMAND_DESCRIPTION = "Show telemetry of current session.";

/** 启用本地工具调用遥测，并注册当前 session 的只读分析视图。 */
export default function telemetryExtension(pi: ExtensionAPI, present?: TelemetryPresenter): void {
	const service = registerTelemetry(pi);
	registerTelemetryCommand(pi, service, present);
}

export function registerTelemetryCommand(
	pi: Pick<ExtensionAPI, "registerCommand">,
	service: Pick<TelemetryService, "snapshot">,
	present?: TelemetryPresenter,
): void {
	pi.registerCommand("telemetry", {
		description: COMMAND_DESCRIPTION,
		async handler(_args, ctx) {
			const [{ createLiveTelemetryReport }, { formatLiveTelemetrySummary }] = await Promise.all([
				import("../telemetry-report/live.js"),
				import("../telemetry-report/presentation/summary.js"),
			]);
			const report = createLiveTelemetryReport(service.snapshot());
			if (ctx.mode !== "tui" || present === undefined) {
				ctx.ui.notify(formatLiveTelemetrySummary(report), "info");
				return;
			}
			await present(ctx, report);
		},
	});
}
