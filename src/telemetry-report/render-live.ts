import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { CandidateRankingCoreStatistics, ToolStatistics } from "./types.js";
import type { LiveTelemetryReport } from "./live.js";

const WIDE_WIDTH = 76;

/** 渲染当前会话报告；使用紧凑分组和表格，减少浮层滚动距离。 */
export function renderLiveTelemetry(value: LiveTelemetryReport, width: number): string[] {
	const maxWidth = Math.max(1, width);
	const report = value.report;
	const lines = [
		align("Telemetry / Current Session", "q close  ↑↓ scroll", maxWidth),
		"",
		"Session Info",
		inlineValues([
			["Session", value.session_id === undefined ? "n/a" : shortId(value.session_id)],
			["Run", value.run_id === undefined ? "n/a" : shortId(value.run_id)],
		]),
		inlineValues([
			["Status", value.enabled ? "Enabled" : "Disabled"],
			["Pending", value.pending_calls],
			["Completed", report.inventory.calls],
			["Tools", report.inventory.tools],
		]),
		inlineValues([
			["Multi-scope", report.tools.reduce((sum, tool) => sum + tool.multi_scope_calls, 0)],
			["Scope errors", report.tools.reduce((sum, tool) => sum + tool.scope_errors, 0)],
			["Path-list repairs", report.tools.reduce((sum, tool) => sum + (tool.repair.operations["split_path_list"] ?? 0), 0)],
		]),
		`  Generated ${report.metadata.generated_at}`,
		"Tool Calls",
		...toolLines(report.tools, maxWidth),
		"Edits & Batches",
		inlineValues([["Calls", report.edit.calls], ["Failed", report.edit.failed_calls], ["No Change", report.edit.no_change_calls]]),
		inlineValues([["Batches", report.edit.batches.batches], ["Multi-file", report.edit.batches.multi_file_batches], ["Partial Failure", report.edit.batches.partial_failure_batches], ["Reduction", report.edit.batches.potential_call_reduction]]),
		"Candidate Ranking (Heuristic)",
		...candidateBlock("Overall", report.candidate_ranking),
		"Candidate Source Families",
		...(["repo-map", "lsp"] as const).flatMap((source) => {
			const statistics = report.candidate_ranking.by_source_family[source];
			return statistics === undefined ? [`  ${source}  no candidates`] : candidateBlock(source, statistics);
		}),
		"Candidate Sources",
		...sourceLines(report.candidate_ranking.by_source),
	];
	return lines
		.filter((line, index) => line.length > 0 || lines[index - 1]?.length !== 0)
		.flatMap((line) => wrap(line, maxWidth));
}

export function formatLiveTelemetrySummary(value: LiveTelemetryReport): string {
	const report = value.report;
	const status = value.enabled ? "Enabled" : "Disabled";
	return [
		"Current Session Telemetry",
		`Completed calls ${report.inventory.calls}`,
		`Tools ${report.inventory.tools}`,
		`Multi-file batches ${report.edit.batches.multi_file_batches}/${report.edit.batches.batches}`,
		`Multi-scope calls ${report.tools.reduce((sum, tool) => sum + tool.multi_scope_calls, 0)}`,
		`Scope errors ${report.tools.reduce((sum, tool) => sum + tool.scope_errors, 0)}`,
		`Path-list repairs ${report.tools.reduce((sum, tool) => sum + (tool.repair.operations["split_path_list"] ?? 0), 0)}`,
		`Candidates used ${report.candidate_ranking.converted_candidates}/${report.candidate_ranking.candidates}`,
		`Status ${status}`,
		...(value.pending_calls === 0 ? [] : [`Pending ${value.pending_calls}`]),
	].join("  ");
}

function toolLines(tools: readonly ToolStatistics[], width: number): string[] {
	if (tools.length === 0) return ["  no completed tool calls"];
	if (width < WIDE_WIDTH) {
		return tools.flatMap((tool) => [
			`  ${tool.tool}  ${tool.calls} calls  success ${percent(tool.success_rate.value)}  errors ${tool.error_rate.numerator}`,
				`    P50 ${number(tool.duration_ms.p50)} ms  repair ${tool.repair.repaired_rate.numerator}  multi ${tool.multi_scope_calls}  truncated ${tool.truncation_rate.numerator}`,
		]);
	}

	const columns = [
		pad("Tool", 18),
		pad("Calls", 6, true),
		pad("Success", 9, true),
		pad("Errors", 6, true),
		pad("P50", 10, true),
		pad("Repair", 8, true),
		pad("Truncated", 8, true),
	];
	const rule = ["─".repeat(18), "─".repeat(6), "─".repeat(9), "─".repeat(6), "─".repeat(10), "─".repeat(8), "─".repeat(8)].join(" ");
	return [
		`  ${columns.join(" ")}`,
		`  ${rule}`,
		...tools.map((tool) => `  ${[
			pad(tool.tool, 18),
			pad(tool.calls, 6, true),
			pad(percent(tool.success_rate.value), 9, true),
			pad(tool.error_rate.numerator, 6, true),
			pad(`${number(tool.duration_ms.p50)}ms`, 10, true),
			pad(tool.repair.repaired_rate.numerator, 8, true),
			pad(tool.truncation_rate.numerator, 8, true),
		].join(" ")}`),
	];
}

function candidateBlock(label: string, statistics: CandidateRankingCoreStatistics): string[] {
	const converted = statistics.candidates === 0 ? "n/a" : `${statistics.converted_candidates}/${statistics.candidates}(${percent(statistics.candidate_conversion_rate)})`;
	const mrr = statistics.mrr.samples === 0 ? "n/a" : decimal(statistics.mrr.value);
	return [
		`  ${label}  generated ${statistics.producer_calls}  candidates ${statistics.candidates}  used ${converted}`,
		`    MRR ${mrr}  hits ${conversionSummary(statistics)}  downstream ${consumerSummary(statistics)}`,
	];
}

function conversionSummary(statistics: CandidateRankingCoreStatistics): string {
	const values = statistics.conversion_at_k.filter((item) => item.lists > 0);
	return values.length === 0 ? "n/a" : values.map((item) => `K${item.k} ${item.converted_lists}/${item.lists}(${percent(item.rate)})`).join(" ");
}

function consumerSummary(statistics: CandidateRankingCoreStatistics): string {
	const consumers = Object.entries(statistics.downstream_consumers);
	return consumers.length === 0 ? "none" : consumers.map(([tool, count]) => `${tool}:${count}`).join(" ");
}

function sourceLines(sources: Readonly<Record<string, CandidateRankingCoreStatistics>>): string[] {
	const values = Object.entries(sources);
	return values.length === 0 ? ["  no candidate sources"] : values.flatMap(([source, statistics]) => candidateBlock(source, statistics));
}

function inlineValues(values: readonly (readonly [string, string | number])[]): string {
	return `  ${values.map(([label, value]) => `${label} ${value}`).join("  ")}`;
}

function wrap(value: string, width: number): string[] {
	if (value.length === 0) return [""];
	const lines: string[] = [];
	let remaining = value;
	while (visibleWidth(remaining) > width) {
		const prefix = truncateToWidth(remaining, width, "");
		if (prefix.length === 0) {
			const firstCharacter = Array.from(remaining)[0] ?? "";
			lines.push("");
			remaining = remaining.slice(firstCharacter.length);
			continue;
		}
		const space = prefix.lastIndexOf(" ");
		const head = space > 0 ? prefix.slice(0, space) : prefix;
		lines.push(head);
		remaining = remaining.slice(head.length).trimStart();
	}
	lines.push(remaining);
	return lines;
}

function align(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap > 1 ? `${left}${" ".repeat(gap)}${right}` : `${left} ${right}`;
}

function pad(value: string | number, width: number, start = false): string {
	const text = truncateToWidth(String(value), width, "");
	const padding = " ".repeat(Math.max(0, width - visibleWidth(text)));
	return start ? `${padding}${text}` : `${text}${padding}`;
}

function percent(value: number | undefined): string {
	return value === undefined ? "n/a" : `${Math.round(value * 10_000) / 100}%`;
}

function decimal(value: number): string {
	return value.toFixed(3);
}

function number(value: number | undefined): string | number {
	return value === undefined ? "n/a" : Math.round(value * 100) / 100;
}

function shortId(value: string): string {
	return value.length <= 16 ? value : `${value.slice(0, 12)}…`;
}
