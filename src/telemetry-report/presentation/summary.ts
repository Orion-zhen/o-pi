import type { LiveTelemetryReport } from "../live.js";

/** 非 TUI adapter 使用的紧凑文本摘要；不是结构化 API。 */
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
		...(report.grep.related_recovery.samples === 0
			? []
			: [`Grep related recovery ${report.grep.related_recovery.numerator}/${report.grep.related_recovery.samples}`]),
		`Immediate candidate lists ${report.candidate_ranking.file_level.immediate.adopted_lists}/${report.candidate_ranking.file_level.immediate.lists}`,
		`Status ${status}`,
		...(value.pending_calls === 0 ? [] : [`Pending ${value.pending_calls}`]),
	].join("  ");
}
