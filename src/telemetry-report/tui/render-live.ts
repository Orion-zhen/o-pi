import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { CandidateRankingStatistics, GrepReport, SourceContributionStatistics, ToolStatistics } from "../types.js";
import type { LiveTelemetryReport } from "../live.js";

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
		"Grep Pipeline",
		...grepLines(report.grep),
		"Edits & Batches",
		inlineValues([["Calls", report.edit.calls], ["Failed", report.edit.failed_calls], ["No Change", report.edit.no_change_calls]]),
		inlineValues([["Batches", report.edit.batches.batches], ["Multi-file", report.edit.batches.multi_file_batches], ["Partial Failure", report.edit.batches.partial_failure_batches], ["Reduction", report.edit.batches.potential_call_reduction]]),
		"Candidate Adoption (Unique Attribution)",
		...candidateBlock("Overall", report.candidate_ranking),
		inlineValues([
			["Immediate", `${report.candidate_ranking.file_level.immediate.adopted_lists}/${report.candidate_ranking.file_level.immediate.lists}`],
			["Pre-refinement", `${report.candidate_ranking.file_level.pre_refinement.adopted_lists}/${report.candidate_ranking.file_level.pre_refinement.lists}`],
			["Productive", `${report.candidate_ranking.file_level.productive.adopted_lists}/${report.candidate_ranking.file_level.productive.lists}`],
		]),
		"Candidate Source Families",
		...(["lsp"] as const).flatMap((source) => {
			const statistics = report.candidate_ranking.by_source_family[source];
			return statistics === undefined ? [`  ${source}  no candidates`] : sourceContributionBlock(source, statistics);
		}),
		"Candidate Sources",
		...sourceLines(report.candidate_ranking.by_source),
	];
	return lines
		.filter((line, index) => line.length > 0 || lines[index - 1]?.length !== 0)
		.flatMap((line) => wrap(line, maxWidth));
}

function grepLines(report: GrepReport): string[] {
	if (report.calls === 0) return ["  no grep calls"];
	const relatedDrops = report.capacity.dropped_related_results;
	return [
		`  Calls ${report.calls}  success ${report.successful_calls}  direct ${rateValue(report.direct_match)}  related ${rateValue(report.related_fallback)}  empty ${rateValue(report.empty_result)}`,
		`  Related recovery ${rateValue(report.related_recovery)}  pre-refinement adoption ${rateValue(report.by_result_kind.related.pre_refinement_adoption)}`,
		`  Limits result ${report.limits.result.numerator}  depth ${report.limits.depth.numerator}  entries ${report.limits.entries.numerator}  bytes ${report.limits.bytes.numerator}`,
		`  Internal drops text ${report.capacity.dropped_text_hits.total}  anchors ${report.capacity.dropped_related_anchors.total}  related ${relatedDrops.total}  AST oversized ${report.capacity.ast_skipped_oversized_files.total}`,
		`  Ranking facts ${report.ranking.observed_calls}/${report.successful_calls}`,
		...Object.entries(report.ranking.by_algorithm).flatMap(([algorithm, statistics]) => {
			const immediateNdcg = statistics.immediate.ndcg_at_k.find((item) => item.k === 10)?.value;
			const productiveNdcg = statistics.productive.ndcg_at_k.find((item) => item.k === 10)?.value;
			return [
				`    ${algorithm}  calls ${statistics.calls}  pool ${number(statistics.candidate_pool.mean)} -> eligible ${number(statistics.eligible_candidates.mean)} -> selected ${number(statistics.selected_candidates.mean)}`,
				`      replacements ${number(statistics.mmr_replacements.mean)}  file gain ${number(statistics.file_diversity_gain.mean)}  immediate MRR/nDCG10 ${decimal(statistics.immediate.mrr.value)}/${decimal(immediateNdcg)}  productive ${decimal(statistics.productive.mrr.value)}/${decimal(productiveNdcg)}`,
			];
		}),
		...(report.findings.length === 0 ? [] : [`  Findings ${report.findings.map((finding) => finding.code).join(", ")}`]),
	];
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

function candidateBlock(label: string, statistics: CandidateRankingStatistics): string[] {
	const immediate = statistics.file_level.immediate;
	const adopted = immediate.lists === 0 ? "n/a" : `${immediate.adopted_lists}/${immediate.lists}(${percent(immediate.adoption_rate)})`;
	const mrr = immediate.mrr.samples === 0 ? "n/a" : decimal(immediate.mrr.value);
	return [
		`  ${label}  generated ${statistics.producer_calls}  exposures ${statistics.file_level.exposures}  immediate ${adopted}`,
		`    MRR ${mrr}  hits ${conversionSummary(statistics)}`,
	];
}

function conversionSummary(statistics: CandidateRankingStatistics): string {
	const values = statistics.file_level.immediate.hit_at_k.filter((item) => item.lists > 0);
	return values.length === 0 ? "n/a" : values.map((item) => `K${item.k} ${item.converted_lists}/${item.lists}(${percent(item.rate)})`).join(" ");
}

function sourceLines(sources: Readonly<Record<string, SourceContributionStatistics>>): string[] {
	const values = Object.entries(sources);
	return values.length === 0 ? ["  no candidate sources"] : values.flatMap(([source, statistics]) => sourceContributionBlock(source, statistics));
}

function sourceContributionBlock(label: string, statistics: SourceContributionStatistics): string[] {
	return [`  ${label}  participation ${statistics.participation_exposures}  exclusive ${statistics.exclusive_exposures}  productive bounds ${statistics.exclusive_productive}-${statistics.participation_productive}`];
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

function decimal(value: number | undefined): string {
	return value === undefined ? "n/a" : value.toFixed(3);
}

function rateValue(value: { numerator: number; samples: number; value?: number }): string {
	return value.samples === 0 ? "n/a" : `${value.numerator}/${value.samples}(${percent(value.value)})`;
}

function number(value: number | undefined): string | number {
	return value === undefined ? "n/a" : Math.round(value * 100) / 100;
}

function shortId(value: string): string {
	return value.length <= 16 ? value : `${value.slice(0, 12)}…`;
}
