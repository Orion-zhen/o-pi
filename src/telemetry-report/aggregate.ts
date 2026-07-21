import type { CallRecord, RunRecord, TelemetryRecord } from "../telemetry/types.js";
import { collectCandidateObservations } from "./analyzers/candidate-observations.js";
import { summarizeCandidateRanking } from "./analyzers/candidate-ranking.js";
import { analyzeEdits } from "./analyzers/edit.js";
import { summarizeSearchEffectiveness } from "./analyzers/search-effectiveness.js";
import { compare, frequency, numericSummary, rateSummary } from "./shared.js";
import type { TelemetryReport, TelemetryReportQuery, ToolStatistics } from "./types.js";

export interface AggregateTelemetryOptions {
	generatedAt?: string;
	query?: TelemetryReportQuery;
	inputFiles?: string[];
	invalidLines?: number;
}

export function aggregateTelemetry(records: readonly TelemetryRecord[], options: AggregateTelemetryOptions = {}): TelemetryReport {
	const query = options.query ?? {};
	const allRuns = records.filter((record): record is RunRecord => record.type === "run");
	const allCalls = records.filter((record): record is CallRecord => record.type === "call");
	const runs = allRuns.filter((run) => matchesRun(run, query)).sort((left, right) => compare(left.at, right.at));
	const runIds = new Set(runs.map((run) => run.run_id));
	const calls = allCalls.filter((call) => runIds.has(call.run_id) && matchesCall(call, query));
	const cwdByRun = new Map(runs.map((run) => [run.run_id, run.cwd]));
	const toolNames = [...new Set(calls.map((call) => call.tool))].sort(compare);
	const candidateObservations = collectCandidateObservations(calls, cwdByRun);
	return {
		metadata: {
			generated_at: options.generatedAt ?? new Date().toISOString(),
			input_files: [...(options.inputFiles ?? [])].sort(compare),
			parsed_records: records.length,
			invalid_lines: options.invalidLines ?? 0,
		},
		query,
		inventory: {
			runs: runs.length,
			sessions: new Set(runs.map((run) => run.session_id)).size,
			calls: calls.length,
			tools: toolNames.length,
		},
		runs,
		tools: toolNames.map((tool) => summarizeTool(tool, calls.filter((call) => call.tool === tool))),
		edit: analyzeEdits(calls, cwdByRun),
		search_effectiveness: summarizeSearchEffectiveness(calls, candidateObservations),
		candidate_ranking: summarizeCandidateRanking(candidateObservations),
	};
}

function summarizeTool(tool: string, calls: readonly CallRecord[]): ToolStatistics {
	const repairs = calls.filter((call) => call.repair !== undefined);
	return {
		tool,
		calls: calls.length,
		success_rate: rateSummary(calls.filter((call) => call.status === "success").length, calls.length),
		error_rate: rateSummary(calls.filter((call) => call.status === "error").length, calls.length),
		duration_ms: numericSummary(calls.map((call) => call.duration_ms)),
		output_chars: numericSummary(calls.flatMap((call) => call.output_chars ?? [])),
		truncation_rate: rateSummary(calls.filter((call) => call.truncated === true).length, calls.length),
		error_codes: frequency(calls.filter((call) => call.status === "error").flatMap((call) => call.error?.code ?? [])),
		repair: {
			observed_calls: repairs.length,
			repaired_rate: rateSummary(repairs.filter((call) => call.repair?.status === "repaired").length, repairs.length),
			operations: frequency(repairs.flatMap((call) => call.repair?.operations ?? [])),
		},
	};
}

function matchesRun(run: RunRecord, query: TelemetryReportQuery): boolean {
	return includes(query.git_commits, run.git?.commit)
		&& (query.git_dirty === undefined || query.git_dirty.includes(run.git?.dirty ?? false));
}

function matchesCall(call: CallRecord, query: TelemetryReportQuery): boolean {
	return includes(query.tools, call.tool)
		&& (query.from === undefined || call.at >= query.from)
		&& (query.to === undefined || call.at <= query.to);
}

function includes(values: readonly string[] | undefined, value: string | undefined): boolean {
	return values === undefined || (value !== undefined && values.includes(value));
}
