import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatsReport } from "../../src/gui/ui/reports/stats-report.tsx";
import { UsageReport } from "../../src/gui/ui/reports/usage-report.tsx";
import { TelemetryReport } from "../../src/gui/ui/reports/telemetry-report.tsx";
import { statsReport, usageReport, telemetryReport } from "./report-fixtures.ts";

const reports = [
	["stats", createElement(StatsReport, { value: statsReport })],
	["usage", createElement(UsageReport, { value: usageReport })],
	["telemetry", createElement(TelemetryReport, { value: telemetryReport })],
] as const;
process.stdout.write(JSON.stringify(reports.map(([name, report]) => ({
	name,
	html: renderToStaticMarkup(createElement("main", { className: "panel" }, createElement("div", { className: "panel-body" }, report))),
}))));
