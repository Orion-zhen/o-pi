import type { TelemetryServiceSnapshot } from "../telemetry/service.ts";
import { aggregateTelemetry } from "./aggregate.ts";
import type { TelemetryReport } from "./types.ts";

export interface LiveTelemetryReport {
	report: TelemetryReport;
	run_id?: string;
	session_id?: string;
	enabled: boolean;
	pending_calls: number;
}

/** Analyze the current collector snapshot with the same kernel as the offline report. */
export function createLiveTelemetryReport(
	snapshot: TelemetryServiceSnapshot,
	generatedAt = new Date().toISOString(),
): LiveTelemetryReport {
	return {
		report: aggregateTelemetry(snapshot.records, { generatedAt, query: {}, inputFiles: [], invalidLines: 0 }),
		...(snapshot.run_id === undefined ? {} : { run_id: snapshot.run_id }),
		...(snapshot.session_id === undefined ? {} : { session_id: snapshot.session_id }),
		enabled: snapshot.enabled,
		pending_calls: snapshot.pending_calls,
	};
}
