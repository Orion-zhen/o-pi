import type { LiveTelemetryReport } from "../../../harness/telemetry-report/live.ts";
import type { AdoptionWindowStatistics, NumericSummary, RateSummary } from "../../../harness/telemetry-report/types.ts";
import { Bar, duration, Empty, Facts, Metrics, number, percent, ReportStamp, Section } from "./shared.tsx";

const ratePercent = (rate: RateSummary) => rate.value === undefined ? undefined : rate.value * 100;
const rateText = (rate: RateSummary) => `${percent(ratePercent(rate))} · ${number(rate.numerator)} / ${number(rate.samples)}`;
const distribution = (value: NumericSummary, format = number) => `平均 ${format(value.mean)} · P50 ${format(value.p50)} · P95 ${format(value.p95)} · ${number(value.samples)} 个样本`;

function Adoption({ label, value }: { label: string; value: AdoptionWindowStatistics }) {
	return <Bar label={label} value={value.lists > 0 ? value.adoption_rate * 100 : undefined} text={value.lists > 0 ? `${percent(value.adoption_rate * 100)} · ${number(value.adopted_lists)} / ${number(value.lists)}` : "暂无样本"} />;
}

export function TelemetryReport({ value }: { value: LiveTelemetryReport }) {
	const { report } = value;
	const tools = [...report.tools].sort((a, b) => b.calls - a.calls);
	const maxCalls = Math.max(0, ...tools.map((tool) => tool.calls));
	const successes = tools.reduce((sum, tool) => sum + tool.success_rate.numerator, 0);
	const samples = tools.reduce((sum, tool) => sum + tool.success_rate.samples, 0);
	const errors = tools.reduce((sum, tool) => sum + tool.error_rate.numerator, 0);
	const { grep, edit, candidate_ranking: candidates, search_effectiveness: search } = report;
	return <div className="report-dashboard">
		<div className="report-intro"><span className="report-badge" data-tone={value.enabled ? "success" : "warning"}>{value.enabled ? "采集已启用" : "采集已停用"}</span><h2>工具运行概览</h2><p>当前会话的工具执行与搜索效果快照。</p></div>
		<Metrics items={[
			{ label: "已完成调用", value: number(report.inventory.calls) },
			{ label: "成功率", value: percent(samples > 0 ? successes / samples * 100 : undefined), tone: "success" },
			{ label: "错误次数", value: number(errors), tone: errors > 0 ? "danger" : "accent" },
			{ label: "进行中", value: number(value.pending_calls) },
		]} />
		<Section title="工具调用对比">
			{tools.length === 0 ? <Empty>尚无已完成的工具调用。</Empty> : <div className="report-bars">{tools.map((tool) => <div className="report-tool" key={tool.tool}>
				<Bar label={tool.tool} value={maxCalls > 0 ? tool.calls / maxCalls * 100 : undefined} text={`${number(tool.calls)} 次`} hint={`成功率 ${percent(ratePercent(tool.success_rate))} · P50 ${duration(tool.duration_ms.p50)} · P95 ${duration(tool.duration_ms.p95)}`} tone={tool.error_rate.numerator > 0 ? "warning" : "accent"} />
				<details className="report-details"><summary>{tool.tool} 详细指标</summary><Facts items={[
					["成功", rateText(tool.success_rate)], ["错误", rateText(tool.error_rate)], ["输出截断", rateText(tool.truncation_rate)],
					["耗时", distribution(tool.duration_ms, duration)], ["输出字符", distribution(tool.output_chars)],
					["多范围调用", number(tool.multi_scope_calls)], ["范围错误", number(tool.scope_errors)],
					["参数修复", rateText(tool.repair.repaired_rate)], ["分发调用", number(tool.repair.fanout_calls)],
					...Object.entries(tool.error_codes).map(([code, count]): [string, string] => [`错误 · ${code}`, number(count)]),
					...Object.entries(tool.repair.operations).map(([operation, count]): [string, string] => [`修复 · ${operation}`, number(count)]),
				]} /></details>
			</div>)}</div>}
		</Section>
		<Section title="搜索效果" detail>
			{search.calls === 0 ? <Empty>尚无搜索调用。</Empty> : <>
				<Metrics items={[{ label: "搜索次数", value: number(search.calls) }, { label: "候选数", value: number(search.candidates) }, { label: "后续检查", value: number(search.downstream_inspections) }, { label: "后续修改", value: number(search.downstream_mutations) }]} />
				<Bar label="候选转化率" value={search.candidates > 0 ? search.candidate_conversion_rate * 100 : undefined} hint={`${number(search.converted_candidates)} 个候选被后续操作使用`} />
				<Facts items={[["有候选的调用", number(search.calls_with_candidates)], ["零候选调用", number(search.zero_candidate_calls)], ["扫描文件数", number(search.scanned_files)]]} />
				{Object.entries(search.by_tool).map(([tool, stats]) => <Bar key={tool} label={tool} value={stats.candidates > 0 ? stats.candidate_conversion_rate * 100 : undefined} hint={`${number(stats.calls)} 次调用 · ${number(stats.converted_candidates)} / ${number(stats.candidates)} 个候选被采用`} />)}
				<p className="report-note">基于后续操作推断的启发式指标，不代表搜索质量的精确评分。</p>
			</>}
		</Section>
		<Section title="Grep 管线" detail>
			{grep.calls === 0 ? <Empty>尚无 grep 调用。</Empty> : <>
				<Facts items={[["调用", number(grep.calls)], ["成功 / 失败", `${number(grep.successful_calls)} / ${number(grep.failed_calls)}`], ["排名采样", `${number(grep.ranking.observed_calls)} / ${number(grep.successful_calls)}`]]} />
				<div className="report-bars">{([ ["直接命中", grep.direct_match], ["关联回退", grep.related_fallback], ["空结果", grep.empty_result], ["关联恢复", grep.related_recovery] ] as const).map(([label, rate]) => <Bar key={label} label={label} value={ratePercent(rate)} text={rateText(rate)} />)}</div>
				<Facts items={[
					["搜索文件", distribution(grep.work.searched_files)], ["解析文件", distribution(grep.work.parsed_files)], ["返回区域", distribution(grep.work.returned_regions)], ["估算 Token", distribution(grep.work.approx_tokens)],
					["结果上限触发", rateText(grep.limits.result)], ["深度上限触发", rateText(grep.limits.depth)], ["条目上限触发", rateText(grep.limits.entries)], ["字节上限触发", rateText(grep.limits.bytes)],
					["丢弃文本命中", number(grep.capacity.dropped_text_hits.total)], ["丢弃关联结果", number(grep.capacity.dropped_related_results.total)], ["超大文件跳过", number(grep.capacity.ast_skipped_oversized_files.total)],
				]} />
				{Object.entries(grep.ranking.by_algorithm).map(([algorithm, stats]) => <details className="report-details" key={algorithm}><summary>{algorithm} 排名分析</summary><Facts items={[
					["调用", number(stats.calls)], ["平均候选池", number(stats.candidate_pool.mean)], ["平均入选候选", number(stats.selected_candidates.mean)], ["平均替换数", number(stats.mmr_replacements.mean)], ["平均文件多样性增益", number(stats.file_diversity_gain.mean)],
				]} /><Adoption label="即时采用" value={stats.immediate} /><Adoption label="有效采用" value={stats.productive} /></details>)}
				{grep.findings.map((finding) => <p className="report-message" data-tone={finding.severity === "warning" ? "warning" : "accent"} key={finding.code}>{finding.summary}<small>{rateText(finding.evidence)}</small></p>)}
			</>}
		</Section>
		<Section title="编辑与批处理" detail>
			{edit.calls === 0 ? <Empty>尚无编辑调用。</Empty> : <>
				<Metrics items={[{ label: "编辑调用", value: number(edit.calls) }, { label: "成功", value: number(edit.successful_calls), tone: "success" }, { label: "失败", value: number(edit.failed_calls) }, { label: "无变更", value: number(edit.no_change_calls) }]} />
				<Facts items={[["每次编辑数", distribution(edit.edits_per_call)], ["批次数", number(edit.batches.batches)], ["多文件批次", number(edit.batches.multi_file_batches)], ["部分失败批次", number(edit.batches.partial_failure_batches)], ["潜在可减少调用数", number(edit.batches.potential_call_reduction)], ["每批调用数", distribution(edit.batches.calls_per_batch)], ["每批文件数", distribution(edit.batches.files_per_batch)]]} />
			</>}
		</Section>
		<Section title="候选采用与来源" detail>
			{candidates.producer_calls === 0 ? <Empty>尚无候选采用样本。</Empty> : <>
				<Metrics items={[{ label: "候选生成调用", value: number(candidates.producer_calls) }, { label: "候选数", value: number(candidates.candidates) }]} />
				<Adoption label="即时采用" value={candidates.file_level.immediate} /><Adoption label="细化前采用" value={candidates.file_level.pre_refinement} /><Adoption label="有效采用" value={candidates.file_level.productive} />
				<Facts items={[["即时 MRR", candidates.file_level.immediate.mrr.samples > 0 ? number(candidates.file_level.immediate.mrr.value) : "暂无样本"], ["每千字符有效采用列表", number(candidates.output_efficiency.productive_adopted_lists_per_1000_chars)], ["无后续操作输出占比", percent(candidates.output_efficiency.no_action_output_share * 100)]]} />
				<div className="report-bars">{Object.entries(candidates.by_source).map(([source, stats]) => <Bar key={source} label={source} value={stats.participation_exposures > 0 ? stats.participation_productive_rate * 100 : undefined} hint={`参与 ${number(stats.participation_exposures)} · 独占 ${number(stats.exclusive_exposures)} · 有效贡献 ${number(stats.exclusive_productive)}–${number(stats.participation_productive)}`} />)}</div>
				<p className="report-note">采用率为启发式归因；多个来源的贡献可能重叠，不能直接相加。</p>
			</>}
		</Section>
		<Section title="采集详情" detail><Facts items={[["会话 ID", value.session_id ?? "未提供"], ["运行 ID", value.run_id ?? "未提供"], ["工具种类", number(report.inventory.tools)], ["已解析记录", number(report.metadata.parsed_records)], ["无效记录", number(report.metadata.invalid_lines)]]} /></Section>
		<ReportStamp at={report.metadata.generated_at} />
	</div>;
}
