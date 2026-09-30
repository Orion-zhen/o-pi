import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { CallRecord, Candidate, RunRecord } from "../../../src/harness/telemetry/types.ts";
import type { TelemetryReportQuery } from "../../../src/harness/telemetry-report/types.ts";
import { aggregateTelemetry } from "../../../src/harness/telemetry-report/aggregate.ts";
import { generateTelemetryReport } from "../../../src/harness/telemetry-report/command.ts";
import { renderTelemetryHtml } from "../../../src/harness/telemetry-report/html.ts";
import { renderLiveTelemetry } from "../../../src/tui/views/telemetry-report/render-live.ts";
import { preserveEnv, setTestHome, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("o-pi-report-");
preserveEnv("HOME", "USERPROFILE");
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const run: RunRecord = { type: "run", run_id: "run", at: at(0), session_id: "session", reason: "startup", cwd: "/repo" };
const file = (value = "src/a.ts") => ({ kind: "file", value });
function candidate(rank = 1, value = "src/a.ts", extra: Partial<Candidate> = {}): Candidate {
	return { ...file(value), rank, sources: ["lexical"], ...extra };
}
function call(index: number, tool: string, extra: Partial<CallRecord> = {}): CallRecord {
	return {
		type: "call", run_id: "run", call_id: `call-${index}`, call_index: index, tool,
		at: at(index + 1), started_at: at(index + 1), ended_at: at(index + 1), duration_ms: 1, status: "success", ...extra,
	};
}
function report(calls: CallRecord[], query: TelemetryReportQuery = {}, runs = [run]) {
	return aggregateTelemetry([...runs, ...calls], { generatedAt: at(100), query, inputFiles: [], invalidLines: 0 });
}
const search = (index = 0) => call(index, "find", { candidates: [candidate()] });
const read = (index = 1, extra: Partial<CallRecord> = {}) => call(index, "read", { targets: [file()], ...extra });
const grepFields = (hits: number, returned: number, related: number) => ({
	text_hit_count: hits, returned_match_count: returned, returned_verified_candidate_count: returned - related,
	returned_related_candidate_count: related,
});

describe("遥测报告业务流程", () => {
	it("读取 JSONL、跳过损坏尾行并写出安全的 JSON/HTML 报告", async () => {
		const input = path.join(temp.path, "input");
		const output = path.join(temp.path, "output");
		await mkdir(input);
		await writeFile(path.join(input, "run.jsonl"), [run, search(), read(), call(2, "<script>alert(1)</script>")]
			.map((record) => JSON.stringify(record)).join("\n") + '\n{broken\n');
		const result = await generateTelemetryReport({ inputDirectory: input, outputDirectory: output });
		expect(result.report.inventory).toMatchObject({ runs: 1, calls: 3 });
		expect(result.report.metadata.invalid_lines).toBe(1);
		expect(JSON.parse(await readFile(path.join(output, "report.json"), "utf8"))).toEqual(result.report);
		const html = await readFile(path.join(output, "report.html"), "utf8");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script>alert(1)</script>");
	});

	it("默认目录尚未创建时生成空报告，显式错误路径仍报错", async () => {
		setTestHome(temp.path);
		const outputDirectory = path.join(temp.path, "output");
		expect((await generateTelemetryReport({ outputDirectory })).report.inventory.calls).toBe(0);
		await expect(generateTelemetryReport({ inputDirectory: path.join(temp.path, "missing"), outputDirectory }))
			.rejects.toMatchObject({ code: "ENOENT" });
	});

	it("汇总成功率、耗时、截断和参数修复，不把未知 Git 状态当成干净工作区", () => {
		const calls = [
			call(0, "bash", { duration_ms: 10, repair: { status: "repaired", operations: ["root_alias"] } }),
			call(1, "bash", { duration_ms: 30, status: "error", error: { code: "EXIT_1" }, truncated: true }),
		];
		expect(report(calls).tools[0]).toMatchObject({
			success_rate: { value: 0.5 }, duration_ms: { mean: 20, p50: 10, p95: 30 },
			error_codes: { EXIT_1: 1 }, truncation_rate: { value: 0.5 }, repair: { operations: { root_alias: 1 } },
		});
		expect(report(calls, { git_dirty: [false] }).inventory.calls).toBe(0);
		const known = { ...run, git: { root: "/repo", commit: "abc", dirty: false as const } };
		expect(report(calls, { git_commits: ["abc"], tools: ["bash"], from: at(2) }, [known]).inventory.calls).toBe(1);
	});

	it("嵌套搜索计入执行次数，不冒充模型看到的候选", () => {
		const value = report([call(0, "codemode"), { ...search(1), parent_call_id: "call-0" }, read(2)]);
		expect(value.inventory.calls).toBe(3);
		expect(value.candidate_ranking.producer_calls).toBe(0);
	});

	it.each([
		["读取搜索结果", [search(), read()], 1],
		["失败读取", [search(), read(1, { status: "error" })], 0],
		["同一并行批次", [
			{ ...search(), batch: { id: "batch", size: 2, index: 0 } },
			read(1, { batch: { id: "batch", size: 2, index: 1 } }),
		], 0],
		["最近一次搜索独占归因", [search(), search(1), read(2)], 1],
	] as const)("%s", (_name, calls, adopted) => {
		const value = report([...calls]);
		expect(value.candidate_ranking.file_level.broad.adopted_lists).toBe(adopted);
	});

	it("范围读取只采用相交区域，整文件读取不猜测区域采用", () => {
		const grep = call(0, "grep", { candidates: [
			candidate(3, "src/a.ts", { kind: "region", start_line: 10, end_line: 20 }),
			candidate(1, "src/a.ts", { kind: "region", start_line: 10, end_line: 20, sources: ["lsp-reference"] }),
			candidate(2, "src/a.ts", { kind: "region", start_line: 30, end_line: 40 }),
		] });
		const ranged = report([grep, read(1, { targets: [{ ...file(), kind: "region", start_line: 15, end_line: 16 }] })]).candidate_ranking;
		expect(ranged.file_level.exposures).toBe(1);
		expect(ranged.region_level).toMatchObject({ exposures: 2, immediate: { adopted_lists: 1, unknown_lists: 0 } });
		expect(report([grep, read()]).candidate_ranking.region_level.immediate).toMatchObject({ adopted_lists: 0, unknown_lists: 1 });
	});

	it("再次搜索区分即时采用、搜索放弃与后续采用", () => {
		const value = report([search(), call(1, "grep"), read(2)]).candidate_ranking.file_level;
		expect(value).toMatchObject({ search_abandonment: 1, pre_refinement: { adopted_lists: 0 }, broad: { adopted_lists: 1 } });
	});

	it.each([[10, 11, 1], [11, 12, 0], [1, 302, 0]])("后续采用限制调用间隔 %i 和时间 %i", (index, seconds, expected) => {
		const calls = [search(), ...Array.from({ length: index - 1 }, (_, i) => call(i + 1, "bash")), read(index, { at: at(seconds) })];
		expect(report(calls).candidate_ranking.file_level.broad.adopted_lists).toBe(expected);
	});

	it("搜索、读取、修改组成有效采用，重复来源不重复计数", () => {
		const value = report([
			call(0, "read", { targets: [file("src/known.ts")] }),
			call(1, "grep", { output_chars: 1000, candidates: [
				candidate(1, "src/known.ts"), candidate(2, "src/a.ts", { sources: ["lexical", "lsp-workspace-symbol"] }),
			] }),
			read(2), call(3, "edit", { targets: [file()] }),
		]).candidate_ranking;
		expect(value.file_level.actions).toMatchObject({ inspection: 1, mutation: 1, productive: 1 });
		expect(value.file_level.novelty).toMatchObject({ novel_exposures: 1, prior_known_exposures: 1, novel_productive: 1 });
		expect(value.by_source["lsp-workspace-symbol"]).toMatchObject({ participation_productive: 1, exclusive_productive: 0 });
		expect(value.output_efficiency.chars_per_productive_adopted_list).toBe(1000);
	});

	it("排名质量来自实际后续采用，不把未选择候选算作命中", () => {
		const value = report([
			call(0, "find", { candidates: [1, 2, 4, 6].map((rank) => candidate(rank, `src/${rank}.ts`)) }),
			read(1, { targets: [file("src/4.ts")] }), read(2, { targets: [file("src/2.ts")] }),
			call(3, "edit", { targets: [file("src/6.ts")] }),
		]).candidate_ranking.file_level;
		expect(value.immediate.mrr.value).toBe(0.25);
		expect(value.immediate.hit_at_k.map((item) => item.converted_lists)).toEqual([0, 0, 1, 1]);
		expect(value.immediate.ndcg_at_k.at(-1)?.value).toBeCloseTo(1 / Math.log2(5));
		expect(value.pre_refinement.retention_at_k.map((item) => item.rate)).toEqual([0, 1 / 3, 2 / 3, 1]);
		expect(value.productive.mrr.value).toBe(1 / 6);
	});

	it("区分 grep 的直接命中、关联恢复、空结果与缺失观测", () => {
		const value = report([
			call(0, "grep", { fields: grepFields(2, 1, 0) }),
			call(1, "grep", { fields: { ...grepFields(0, 1, 1), dropped_related_result_count: 3, truncation_reasons: ["result_limit"] } }),
			call(2, "grep", { fields: grepFields(0, 0, 0) }), call(3, "grep"),
		]).grep;
		expect(value).toMatchObject({
			calls: 4, execution_path_observed_calls: 3, direct_match: { numerator: 1 },
			related_recovery: { value: 0.5 }, empty_result: { numerator: 1 },
			capacity: { dropped_related_results: { total: 3 } }, limits: { result: { numerator: 1 } },
		});
		expect(value.findings.some((item) => item.code === "incomplete_pipeline_facts")).toBe(true);
	});

	it("同批编辑保留部分失败，范围修复统计不包含原始参数", () => {
		const value = report([0, 1, 2].map((index) => call(index, "edit", {
			batch: { id: "batch", size: 3, index }, targets: [file(`src/${index}.ts`)],
			status: index === 2 ? "error" : "success", fields: { input_edit_count: 1, changed: index !== 2 },
		})));
		expect(value.edit).toMatchObject({ successful_calls: 2, failed_calls: 1, batches: { multi_file_batches: 1, partial_failure_batches: 1 } });
		const repaired = report([call(0, "find", {
			fields: { input_path_count: 2, scope_count: 3, scope_error_count: 1 },
			repair: { status: "repaired", operations: ["split_path_list"], fanout: { field: "path", count: 2, separator: "whitespace" } },
		})]).tools[0];
		expect(repaired).toMatchObject({ multi_scope_calls: 1, scope_errors: 1, repair: { fanout_calls: 1, fanout_scopes: { mean: 2 } } });
	});

	it.each([48, 100])("当前会话报告在 %i 列内展示，空报告不伪造指标", (width) => {
		const lines = renderLiveTelemetry({ report: report([search(), read()]), enabled: true, pending_calls: 1 }, width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(renderLiveTelemetry({ report: report([]), enabled: true, pending_calls: 0 }, width).join("\n")).not.toMatch(/undefined|null/u);
		expect(renderTelemetryHtml(report([]))).toContain("html");
	});
});
