import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { CandidateRankingCoreStatistics, ToolStatistics } from "./types.js";
import type { LiveTelemetryReport } from "./live.js";

const WIDE_WIDTH = 92;
const LABEL_WIDTH = 14;

/** 渲染当前会话报告；使用分组、标签和值，避免把指标挤在一行。 */
export function renderLiveTelemetry(value: LiveTelemetryReport, width: number): string[] {
	const maxWidth = Math.max(1, width);
	const report = value.report;
	const lines = [
		align("遥测 / 当前会话", "q 关闭  ↑↓ 滚动", maxWidth),
		"",
		"会话信息",
		labelValue("会话", value.session_id === undefined ? "不可用" : shortId(value.session_id)),
		labelValue("运行", value.run_id === undefined ? "不可用" : shortId(value.run_id)),
		labelValue("状态", value.enabled ? "采集已启用" : "采集已禁用"),
		labelValue("进行中", value.pending_calls),
		labelValue("已完成调用", report.inventory.calls),
		labelValue("工具数", report.inventory.tools),
		labelValue("生成时间", report.metadata.generated_at),
		"",
		"工具调用",
		...toolLines(report.tools, maxWidth),
		"",
		"编辑调用",
		labelValue("调用次数", report.edit.calls),
		labelValue("失败", report.edit.failed_calls),
		labelValue("无变化", report.edit.no_change_calls),
		"",
		"批次分析",
		labelValue("并行批次", report.edit.batches.batches),
		labelValue("多文件批次", report.edit.batches.multi_file_batches),
		labelValue("部分失败", report.edit.batches.partial_failure_batches),
		labelValue("可能减少调用", report.edit.batches.potential_call_reduction),
		"",
		"候选项排序（启发式）",
		...candidateBlock("总体", report.candidate_ranking),
		"",
		"候选来源类别",
		...(["repo-map", "lsp"] as const).flatMap((source) => {
			const statistics = report.candidate_ranking.by_source_family[source];
			return statistics === undefined ? [`  ${source}`, "    无候选项"] : candidateBlock(source, statistics);
		}),
		"",
		"候选来源明细",
		...sourceLines(report.candidate_ranking.by_source),
	];
	return lines
		.filter((line, index) => line.length > 0 || lines[index - 1]?.length !== 0)
		.flatMap((line) => wrap(line, maxWidth));
}

export function formatLiveTelemetrySummary(value: LiveTelemetryReport): string {
	const report = value.report;
	const status = value.enabled ? "采集已启用" : "采集已禁用";
	return [
		"当前会话遥测",
		`已完成调用 ${report.inventory.calls}`,
		`工具 ${report.inventory.tools}`,
		`多文件批次 ${report.edit.batches.multi_file_batches}/${report.edit.batches.batches}`,
		`候选项已使用 ${report.candidate_ranking.converted_candidates}/${report.candidate_ranking.candidates}`,
		`状态 ${status}`,
		...(value.pending_calls === 0 ? [] : [`进行中 ${value.pending_calls}`]),
	].join("  ");
}

function toolLines(tools: readonly ToolStatistics[], width: number): string[] {
	if (tools.length === 0) return ["  无已完成的工具调用"];
	if (width < WIDE_WIDTH) {
		return tools.flatMap((tool, index) => [
			...(index === 0 ? [] : [""]),
			`  ${tool.tool}`,
			labelValue("调用次数", tool.calls, 16),
			labelValue("成功率", percent(tool.success_rate.value), 16),
			labelValue("错误", tool.error_rate.numerator, 16),
			labelValue("P50 延迟", `${number(tool.duration_ms.p50)} ms`, 16),
			labelValue("自动修复", tool.repair.repaired_rate.numerator, 16),
			labelValue("输出截断", tool.truncation_rate.numerator, 16),
		]);
	}

	const columns = [
		pad("工具", 22),
		pad("调用", 7, true),
		pad("成功率", 10, true),
		pad("错误", 7, true),
		pad("P50(ms)", 12, true),
		pad("自动修复", 9, true),
		pad("截断", 9, true),
	];
	const rule = ["─".repeat(22), "─".repeat(7), "─".repeat(10), "─".repeat(7), "─".repeat(12), "─".repeat(9), "─".repeat(9)].join(" ");
	return [
		`  ${columns.join(" ")}`,
		`  ${rule}`,
		...tools.map((tool) => `  ${[
			pad(tool.tool, 22),
			pad(tool.calls, 7, true),
			pad(percent(tool.success_rate.value), 10, true),
			pad(tool.error_rate.numerator, 7, true),
			pad(`${number(tool.duration_ms.p50)} ms`, 12, true),
			pad(tool.repair.repaired_rate.numerator, 9, true),
			pad(tool.truncation_rate.numerator, 9, true),
		].join(" ")}`),
	];
}

function candidateBlock(label: string, statistics: CandidateRankingCoreStatistics): string[] {
	return [
		`  ${label}`,
		labelValue("生成调用", statistics.producer_calls),
		labelValue("候选项", statistics.candidates),
		labelValue("已使用", statistics.candidates === 0 ? "无数据" : `${statistics.converted_candidates} / ${statistics.candidates} (${percent(statistics.candidate_conversion_rate)})`),
		labelValue("MRR", statistics.mrr.samples === 0 ? "无数据" : `${decimal(statistics.mrr.value)}（平均倒数排名）`),
		"    命中情况",
		...conversionLines(statistics),
		"    下游工具",
		...consumerLines(statistics),
	];
}

function conversionLines(statistics: CandidateRankingCoreStatistics): string[] {
	const values = statistics.conversion_at_k.filter((item) => item.lists > 0);
	if (values.length === 0) return ["      无数据"];
	return values.map((item) => `      ${pad(`前 ${item.k} 项`, 8)} ${item.converted_lists} / ${item.lists} (${percent(item.rate)})`);
}

function consumerLines(statistics: CandidateRankingCoreStatistics): string[] {
	const consumers = Object.entries(statistics.downstream_consumers);
	return consumers.length === 0 ? ["      无"] : consumers.map(([tool, count]) => `      ${tool}  ${count} 次`);
}

function sourceLines(sources: Readonly<Record<string, CandidateRankingCoreStatistics>>): string[] {
	const values = Object.entries(sources);
	return values.length === 0 ? ["  无候选来源"] : values.flatMap(([source, statistics]) => candidateBlock(source, statistics));
}

function labelValue(label: string, value: string | number, width = LABEL_WIDTH): string {
	return `  ${pad(label, width)} ${value}`;
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
