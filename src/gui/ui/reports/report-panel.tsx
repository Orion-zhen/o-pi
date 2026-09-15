import type { GuiReport } from "../../contract.ts";
import { StatsReport } from "./stats-report.tsx";
import { UsageReport } from "./usage-report.tsx";
import { TelemetryReport } from "./telemetry-report.tsx";
import "./reports.css";

export function ReportPanel({ report }: { report: GuiReport }) {
	switch (report.title) {
		case "会话统计": return <StatsReport value={report.value} />;
		case "套餐用量": return <UsageReport value={report.value} />;
		case "遥测": return <TelemetryReport value={report.value} />;
	}
}
