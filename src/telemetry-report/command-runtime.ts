import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { TelemetryCollector } from "../telemetry/collector.js";
import { LiveTelemetryReporter } from "./live.js";
import { formatLiveTelemetrySummary } from "./render-tui.js";
import { TelemetryViewer } from "./viewer.js";

const reporters = new WeakMap<object, LiveTelemetryReporter>();

/** Heavy report analysis and TUI code is loaded only when /telemetry is invoked. */
export async function runTelemetryCommand(
	collector: Pick<TelemetryCollector, "snapshot">,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (args.trim().length > 0) {
		ctx.ui.notify("usage: /telemetry", "warning");
		return;
	}
	let reporter = reporters.get(collector);
	if (reporter === undefined) {
		reporter = new LiveTelemetryReporter();
		reporters.set(collector, reporter);
	}
	const report = reporter.create(collector);
	if (ctx.mode !== "tui") {
		ctx.ui.notify(formatLiveTelemetrySummary(report), report.report.collection_health.status === "healthy" ? "info" : "warning");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new TelemetryViewer(report, theme, () => tui.terminal.rows, done), {
		overlay: true,
	});
}
