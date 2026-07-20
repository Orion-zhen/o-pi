import type {
	CandidateRankingCoreStatistics,
	CandidateRankingReport,
	RateSummary,
	TelemetryReport,
	ToolStatistics,
} from "./types.js";

export function renderTelemetryHtml(report: TelemetryReport): string {
	const totalSuccess = report.tools.reduce((sum, tool) => sum + tool.success_rate.numerator, 0);
	const totalCalls = report.tools.reduce((sum, tool) => sum + tool.calls, 0);
	const totalErrors = report.tools.reduce((sum, tool) => sum + tool.error_rate.numerator, 0);
	const successRate = rate(totalSuccess, totalCalls);
	const successTone = successRate === undefined ? "" : successRate >= 0.9 ? "good" : successRate < 0.7 ? "bad" : "warning";
	const latestRuns = [...report.runs].reverse().slice(0, 20);
	const hiddenRuns = Math.max(0, report.runs.length - latestRuns.length);

	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi 工具调用分析报告</title><style>
:root{color-scheme:light dark;--bg:#f5f7fb;--surface:#fff;--surface-muted:#f0f3f8;--text:#172033;--muted:#657085;--line:#dce2ec;--accent:#5b5bd6;--accent-soft:#ececff;--green:#16845b;--green-soft:#ddf5e9;--red:#c43d52;--red-soft:#ffeaee;--amber:#a86a00;--amber-soft:#fff1d6;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
@media(prefers-color-scheme:dark){:root{--bg:#10131b;--surface:#181d28;--surface-muted:#222938;--text:#edf1f8;--muted:#9ca8bc;--line:#30394a;--accent:#9b9bf6;--accent-soft:#303052;--green:#5bd49e;--green-soft:#173b2d;--red:#ff8497;--red-soft:#48232d;--amber:#f3bd58;--amber-soft:#44351d}}
*{box-sizing:border-box}body{max-width:1280px;margin:0 auto;padding:32px 24px 56px;background:var(--bg);color:var(--text)}h1,h2,h3{line-height:1.2;margin:0}h1{font-size:30px;letter-spacing:-.02em}h2{font-size:20px;margin-bottom:16px}h3{font-size:15px}.subtitle,.muted{color:var(--muted)}.subtitle{margin:8px 0 0}.header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:26px}.timestamp{text-align:right;color:var(--muted);font-size:12px}.timestamp strong{display:block;color:var(--text);font-size:13px;font-weight:600;margin-top:3px}.cards{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-bottom:28px}.card,.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:0 2px 8px #1720330b}.card{padding:16px}.card-label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}.card-value{font-size:25px;font-weight:700;margin-top:5px;letter-spacing:-.02em}.card-detail{color:var(--muted);font-size:12px;margin-top:2px}.section{margin-top:30px}.panel{overflow:hidden}.panel-header{padding:16px 18px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:16px}.panel-body{padding:18px}table{border-collapse:collapse;width:100%;text-align:left}th{color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}th,td{padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:middle}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:var(--surface-muted)}td:not(:first-child),th:not(:first-child){text-align:right}.tool-name{font-weight:650}.number{font-variant-numeric:tabular-nums;white-space:nowrap}.rate{min-width:104px}.rate-text{display:flex;justify-content:flex-end;gap:7px;align-items:center}.bar{height:5px;width:76px;background:var(--surface-muted);border-radius:99px;overflow:hidden;margin-top:5px;margin-left:auto}.bar span{display:block;height:100%;background:var(--accent);border-radius:inherit}.good{color:var(--green)}.bad{color:var(--red)}.warning{color:var(--amber)}.badge{display:inline-block;padding:2px 8px;border-radius:99px;background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:600}.badge.good{background:var(--green-soft)}.badge.bad{background:var(--red-soft)}.grid-4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.stat{padding:15px;background:var(--surface-muted);border-radius:9px}.stat-label{color:var(--muted);font-size:12px}.stat-value{font-size:21px;font-weight:700;margin-top:3px}.stat-detail{font-size:12px;color:var(--muted)}.split{display:grid;grid-template-columns:1fr 1fr;gap:16px}.empty{padding:24px;text-align:center;color:var(--muted)}.note{padding:11px 13px;background:var(--accent-soft);border-radius:8px;color:var(--muted);font-size:13px;margin-bottom:14px}.note strong{color:var(--text)}.list-table td:first-child{font-weight:550}.runs td:first-child{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.footer{margin-top:30px;color:var(--muted);font-size:12px}.details{margin-top:12px}.details summary{cursor:pointer;color:var(--muted);font-size:12px}.details-content{margin-top:10px;display:grid;gap:5px;word-break:break-word}.details-content code{font-size:12px}.query{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.query .badge{font-weight:500;background:var(--surface-muted);color:var(--muted)}
@media(max-width:900px){.cards{grid-template-columns:repeat(3,minmax(0,1fr))}.grid-4{grid-template-columns:repeat(2,minmax(0,1fr))}.split{grid-template-columns:1fr}}
@media(max-width:600px){body{padding:22px 14px 40px}.header{display:block}.timestamp{text-align:left;margin-top:12px}.cards,.grid-3,.grid-4{grid-template-columns:repeat(2,minmax(0,1fr))}.panel{overflow-x:auto}table{min-width:700px}.split table{min-width:0}.panel-header{min-width:0}}
</style></head><body>
<header class="header"><div><h1>Pi 工具调用分析</h1><p class="subtitle">本地工具调用的可读摘要</p>${renderQuery(report)}</div><div class="timestamp">生成时间<strong>${escapeHtml(formatTimestamp(report.metadata.generated_at))}</strong></div></header>
<section class="cards">${metricCard("运行次数", report.inventory.runs, `${report.inventory.sessions} 个会话`)}${metricCard("工具调用", report.inventory.calls, `${report.inventory.tools} 个工具`)}${metricCard("成功率", percentage(successRate), `${totalSuccess} / ${totalCalls} 次调用`, successTone)}${metricCard("失败调用", totalErrors, totalErrors === 0 ? "没有失败调用" : "次调用出错", totalErrors === 0 ? "good" : "bad")}${metricCard("编辑调用", report.edit.calls, `${report.edit.batches.multi_file_batches} 个多文件批次`)}</section>
<section class="section"><div class="panel"><div class="panel-header"><h2>工具性能</h2><span class="muted">按工具汇总响应耗时和输出</span></div><div class="panel-body"><table><thead><tr><th>工具</th><th>调用</th><th>成功率</th><th>错误</th><th>p50 耗时</th><th>p95 耗时</th><th>平均输出</th><th>已截断</th><th>已修复</th></tr></thead><tbody>${report.tools.length === 0 ? emptyRow(9, "没有工具调用") : report.tools.map(renderToolRow).join("")}</tbody></table></div></div></section>
<section class="section"><h2>编辑调用：单文件与多文件</h2><div class="split"><div class="panel"><div class="panel-header"><h3>统计结果</h3></div><div class="panel-body grid-4">${stat("编辑调用", report.edit.calls)}${stat("成功", report.edit.successful_calls, "good")}${stat("失败", report.edit.failed_calls, report.edit.failed_calls === 0 ? "good" : "bad")}${stat("无变化", report.edit.no_change_calls)}</div></div><div class="panel"><div class="panel-header"><h3>批处理机会</h3></div><div class="panel-body grid-4">${stat("批次", report.edit.batches.batches)}${stat("多文件", report.edit.batches.multi_file_batches)}${stat("部分失败", report.edit.batches.partial_failure_batches, report.edit.batches.partial_failure_batches === 0 ? "good" : "warning")}${stat("可能减少调用", report.edit.batches.potential_call_reduction, report.edit.batches.potential_call_reduction > 0 ? "good" : "")}</div></div></div></section>
<section class="section"><h2>候选项排名 <small class="muted">（启发式）</small></h2><div class="panel"><div class="panel-body">${renderCandidateRanking(report.candidate_ranking)}</div></div></section>
<section class="section"><div class="panel"><div class="panel-header"><h2>最近运行</h2><span class="muted">${hiddenRuns > 0 ? `显示最近 ${latestRuns.length} 次，共 ${report.runs.length} 次` : `共 ${report.runs.length} 次`}</span></div>${renderRuns(latestRuns)}</div></section>
<footer class="footer">已解析 ${report.metadata.parsed_records} 条记录，来自 ${report.metadata.input_files.length} 个文件。跳过 ${report.metadata.invalid_lines} 条无效记录。${renderFiles(report)}</footer>
</body></html>\n`;
}

export function formatTelemetrySummary(report: TelemetryReport): string {
	return `工具调用 ${report.inventory.calls} 次；多文件批次 ${report.edit.batches.multi_file_batches}/${report.edit.batches.batches}`
		+ `；候选项已使用 ${report.candidate_ranking.converted_candidates}/${report.candidate_ranking.candidates}`;
}

function renderToolRow(tool: ToolStatistics): string {
	return `<tr><td><span class="tool-name">${escapeHtml(tool.tool)}</span></td><td class="number">${tool.calls}</td><td class="rate">${renderRate(tool.success_rate)}</td><td class="number ${tool.error_rate.numerator > 0 ? "bad" : "good"}">${formatRate(tool.error_rate)}</td><td class="number">${formatMs(tool.duration_ms.p50)}</td><td class="number">${formatMs(tool.duration_ms.p95)}</td><td class="number">${formatChars(tool.output_chars.mean)}</td><td class="number">${formatRate(tool.truncation_rate)}</td><td class="number">${formatRate(tool.repair.repaired_rate)}</td></tr>`;
}

function renderCandidateRanking(report: CandidateRankingReport): string {
	const summary = report as CandidateRankingCoreStatistics;
	return `<div class="note"><strong>阅读说明：</strong>候选项在 10 次调用、5 分钟内被后续调用命中时，计为已使用。同一并行批次中的调用不计入。</div>
<div class="grid-4">${stat("生成调用", summary.producer_calls)}${stat("候选项", summary.candidates)}${stat("已使用", `${summary.converted_candidates} (${percentage(summary.candidate_conversion_rate)})`, summary.converted_candidates > 0 ? "good" : "")}${stat("平均倒数排名", formatDecimal(summary.mrr.value), "")}</div>
<div class="split" style="margin-top:16px"><div><h3>按排名统计命中率</h3><table class="list-table"><thead><tr><th>前 K 项</th><th>候选列表</th><th>已命中</th><th>比例</th></tr></thead><tbody>${summary.conversion_at_k.length === 0 ? emptyRow(4, "没有候选列表") : summary.conversion_at_k.map((item) => `<tr><td>前 ${item.k} 项</td><td class="number">${item.lists}</td><td class="number">${item.converted_lists}</td><td class="number">${percentage(item.rate)}</td></tr>`).join("")}</tbody></table></div><div><h3>后续使用的工具</h3>${frequencyTable(summary.downstream_consumers, "没有已使用的候选项")}</div></div>
<div class="split" style="margin-top:16px"><div><h3>来源类别</h3>${coreTable(report.by_source_family, "没有来源类别数据")}</div><div><h3>具体来源</h3>${coreTable(report.by_source, "没有来源数据")}</div></div>`;
}

function coreTable(values: Record<string, CandidateRankingCoreStatistics>, empty: string): string {
	const entries = Object.entries(values);
	if (entries.length === 0) return `<div class="empty">${escapeHtml(empty)}</div>`;
	return `<table class="list-table"><thead><tr><th>来源</th><th>候选项</th><th>已使用</th><th>比例</th></tr></thead><tbody>${entries.map(([name, value]) => `<tr><td>${escapeHtml(name)}</td><td class="number">${value.candidates}</td><td class="number">${value.converted_candidates}</td><td class="number">${percentage(value.candidate_conversion_rate)}</td></tr>`).join("")}</tbody></table>`;
}

function frequencyTable(values: Record<string, number>, empty: string): string {
	const entries = Object.entries(values);
	if (entries.length === 0) return `<div class="empty">${escapeHtml(empty)}</div>`;
	return `<table class="list-table"><thead><tr><th>工具</th><th>使用次数</th></tr></thead><tbody>${entries.map(([name, count]) => `<tr><td>${escapeHtml(name)}</td><td class="number">${count}</td></tr>`).join("")}</tbody></table>`;
}

function renderRuns(runs: TelemetryReport["runs"]): string {
	if (runs.length === 0) return `<div class="empty">没有运行记录</div>`;
	return `<div class="panel-body"><table class="runs"><thead><tr><th>运行</th><th>开始时间</th><th>提交</th><th>工作区</th><th>目录</th></tr></thead><tbody>${runs.map((run) => `<tr><td>${escapeHtml(run.run_id)}</td><td class="number">${escapeHtml(formatTimestamp(run.at))}</td><td>${escapeHtml(run.git?.commit ?? "—")}</td><td>${run.git === undefined ? `<span class="badge">未知</span>` : run.git.dirty ? `<span class="badge warning">有未提交修改</span>` : `<span class="badge good">干净</span>`}</td><td>${escapeHtml(run.cwd)}</td></tr>`).join("")}</tbody></table></div>`;
}

function renderQuery(report: TelemetryReport): string {
	const query = report.query;
	const filters = [
		...(query.tools?.map((tool) => `工具：${tool}`) ?? []),
		...(query.git_commits?.map((commit) => `提交：${commit}`) ?? []),
		...(query.git_dirty?.map((dirty) => `Git 工作区：${dirty ? "有修改" : "干净"}`) ?? []),
		...(query.from === undefined ? [] : [`起始：${query.from}`]),
		...(query.to === undefined ? [] : [`结束：${query.to}`]),
	];
	return filters.length === 0 ? "" : `<div class="query">${filters.map((filter) => `<span class="badge">${escapeHtml(filter)}</span>`).join("")}</div>`;
}

function renderFiles(report: TelemetryReport): string {
	if (report.metadata.input_files.length === 0) return "";
	return `<details class="details"><summary>输入文件</summary><div class="details-content">${report.metadata.input_files.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div></details>`;
}

function metricCard(label: string, value: string | number, detail: string, tone = ""): string {
	return `<div class="card"><div class="card-label">${escapeHtml(label)}</div><div class="card-value ${tone}">${escapeHtml(String(value))}</div><div class="card-detail">${escapeHtml(detail)}</div></div>`;
}

function stat(label: string, value: string | number, tone = ""): string {
	return `<div class="stat"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value ${tone}">${escapeHtml(String(value))}</div></div>`;
}

function renderRate(value: RateSummary): string {
	if (value.samples === 0 || value.value === undefined) return `<span class="muted">—</span>`;
	const tone = value.value >= 0.9 ? "good" : value.value < 0.7 ? "bad" : "warning";
	const width = Math.max(0, Math.min(100, Math.round(value.value * 100)));
	return `<div class="rate-text ${tone}"><span>${percentage(value.value)}</span></div><div class="bar"><span style="width:${width}%"></span></div>`;
}

function formatRate(value: RateSummary): string {
	return value.samples === 0 ? "—" : `${value.numerator}/${value.samples} (${percentage(value.value)})`;
}

function formatMs(value: number | undefined): string {
	return value === undefined ? "—" : `${formatDecimal(value)} ms`;
}

function formatChars(value: number | undefined): string {
	return value === undefined ? "—" : formatDecimal(value);
}

function formatDecimal(value: number | undefined): string {
	if (value === undefined) return "—";
	return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function percentage(value: number | undefined): string {
	return value === undefined ? "—" : `${Math.round(value * 10_000) / 100}%`;
}

function rate(numerator: number, samples: number): number | undefined {
	return samples === 0 ? undefined : numerator / samples;
}

function emptyRow(columns: number, message: string): string {
	return `<tr><td colspan="${columns}" class="empty">${escapeHtml(message)}</td></tr>`;
}

function formatTimestamp(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
		timeZoneName: "short",
	}).format(date).replace(/\//gu, "-");
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/gu, (character) => ({
		"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
	})[character] ?? character);
}
