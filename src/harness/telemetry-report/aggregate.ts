import type { CallRecord, RunRecord, TelemetryRecord } from "../telemetry/types.js";
import { collectCandidateObservations } from "./analyzers/candidate-observations.js";
import { summarizeCandidateRanking } from "./analyzers/candidate-ranking.js";
import { analyzeEdits } from "./analyzers/edit.js";
import { summarizeGrep } from "./analyzers/grep.js";
import { summarizeSearchEffectiveness } from "./analyzers/search-effectiveness.js";
import { compare, frequency, numericSummary, rateSummary } from "./shared.js";
import type { TelemetryReport, TelemetryReportQuery, ToolStatistics } from "./types.js";

export interface AggregateTelemetryOptions {
	generatedAt: string;
	query: TelemetryReportQuery;
	inputFiles: string[];
	invalidLines: number;
}

export function aggregateTelemetry(records: readonly TelemetryRecord[], options: AggregateTelemetryOptions): TelemetryReport {
	const query = options.query;
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
			generated_at: options.generatedAt,
			input_files: [...options.inputFiles],
			parsed_records: records.length,
			invalid_lines: options.invalidLines,
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
		grep: summarizeGrep(calls, candidateObservations),
		search_effectiveness: summarizeSearchEffectiveness(calls, candidateObservations),
		candidate_ranking: summarizeCandidateRanking(candidateObservations),
	};
}

function summarizeTool(tool: string, calls: readonly CallRecord[]): ToolStatistics {
	const repairs = calls.filter((call): call is CallRecord & { repair: NonNullable<CallRecord["repair"]> } => call.repair !== undefined);
	return {
		tool,
		calls: calls.length,
		success_rate: rateSummary(calls.filter((call) => call.status === "success").length, calls.length),
		error_rate: rateSummary(calls.filter((call) => call.status === "error").length, calls.length),
		duration_ms: numericSummary(calls.map((call) => call.duration_ms)),
		output_chars: numericSummary(calls.flatMap((call) => call.output_chars ?? [])),
		truncation_rate: rateSummary(calls.filter((call) => call.truncated === true).length, calls.length),
		error_codes: frequency(calls.filter((call) => call.status === "error").flatMap((call) => call.error?.code ?? [])),
		input_path_count: numericFieldSummary(calls, "input_path_count"),
		scope_count: numericFieldSummary(calls, "scope_count"),
		multi_scope_calls: calls.filter((call) => greaterThanField(call, "input_path_count", 1) || greaterThanField(call, "scope_count", 1)).length,
		scope_error_calls: calls.filter((call) => greaterThanField(call, "scope_error_count", 0)).length,
		scope_errors: calls.flatMap((call) => numericField(call, "scope_error_count") ?? []).reduce((sum, value) => sum + value, 0),
		repair: {
			observed_calls: repairs.length,
			repaired_rate: rateSummary(repairs.filter((call) => call.repair.status === "repaired").length, repairs.length),
			operations: frequency(repairs.flatMap((call) => call.repair.operations)),
			fanout_calls: repairs.filter((call) => call.repair.fanout !== undefined).length,
			fanout_scopes: numericSummary(repairs.flatMap((call) => call.repair.fanout?.count ?? [])),
			fanout_separators: frequency(repairs.flatMap((call) => call.repair.fanout?.separator ?? [])),
		},
	};
}

function numericField(call: CallRecord, key: string): number | undefined {
	const value = call.fields?.[key];
	return typeof value === "number" ? value : undefined;
}

function greaterThanField(call: CallRecord, key: string, threshold: number): boolean {
	const value = numericField(call, key);
	return value !== undefined && value > threshold;
}

function numericFieldSummary(calls: readonly CallRecord[], key: string) {
	return numericSummary(calls.flatMap((call) => numericField(call, key) ?? []));
}

function matchesRun(run: RunRecord, query: TelemetryReportQuery): boolean {
	return includes(query.git_commits, run.git?.commit)
		&& (query.git_dirty === undefined || (run.git !== undefined && query.git_dirty.includes(run.git.dirty)));
}

function matchesCall(call: CallRecord, query: TelemetryReportQuery): boolean {
	return includes(query.tools, call.tool)
		&& (query.from === undefined || call.at >= query.from)
		&& (query.to === undefined || call.at <= query.to);
}

function includes(values: readonly string[] | undefined, value: string | undefined): boolean {
	return values === undefined || (value !== undefined && values.includes(value));
}
