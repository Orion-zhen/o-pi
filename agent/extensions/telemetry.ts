import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTelemetryCommand } from "../../src/telemetry-report/command.js";
import { registerTelemetry } from "../../src/telemetry/collector.js";

/** 采集本地工具遥测，并注册当前 session 的只读分析视图。 */
export default function telemetryExtension(pi: ExtensionAPI): void {
	const collector = registerTelemetry(pi);
	registerTelemetryCommand(pi, collector);
}
