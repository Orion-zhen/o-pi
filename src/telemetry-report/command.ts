import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { TelemetryCollector } from "../telemetry/collector.js";

export function registerTelemetryCommand(
	pi: Pick<ExtensionAPI, "registerCommand">,
	collector: Pick<TelemetryCollector, "snapshot">,
): void {
	pi.registerCommand("telemetry", {
		description: "Show current session telemetry analysis.",
		async handler(args, ctx) {
			const { runTelemetryCommand } = await import("./command-runtime.js");
			await runTelemetryCommand(collector, args, ctx);
		},
	});
}
