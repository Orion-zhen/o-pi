import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import type { CallRecord, Candidate, RunRecord, TelemetryRecord } from "../../src/telemetry/types.js";
import { aggregateTelemetry } from "../../src/telemetry-report/aggregate.js";
import { analyzeCandidateRanking } from "../../src/telemetry-report/analyzers/candidate-ranking.js";
import { analyzeEdits } from "../../src/telemetry-report/analyzers/edit.js";
import { generateTelemetryReport } from "../../src/telemetry-report/command.js";
import { formatTelemetrySummary, renderTelemetryHtml } from "../../src/telemetry-report/html.js";
import { renderLiveTelemetry } from "../../src/telemetry-report/render-live.js";
import { readTelemetryDirectory } from "../../src/telemetry-report/read.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-telemetry-report-");

describe("telemetry report", () => {
	it("reads only the tolerant run/call format", async () => {
		const directory = path.join(temp.path, "read");
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, "run.jsonl"), [
			JSON.stringify(run("run-a", "commit-a")),
			JSON.stringify(call("call-a", 0, "read")),
			JSON.stringify({ ...call("bad", 1, "read"), status: "unfinished" }),
			JSON.stringify({ type: "tool", run_id: "run-a", at: at(0) }),
			"{bad-json",
			"",
		].join("\n"), "utf8");

		const result = await readTelemetryDirectory(directory);
		expect(result.records).toHaveLength(2);
		expect(result.invalid_lines).toBe(3);
		expect(result.files).toEqual([path.join(directory, "run.jsonl")]);
	});

	it("summarizes calls and filters by automatic Git provenance, time, and tool", () => {
		const records: TelemetryRecord[] = [
			run("run-a", "commit-a"),
			run("run-b", "commit-b", true),
			call("ok", 0, "bash", { runId: "run-a", durationMs: 10, outputChars: 20, repair: { status: "repaired", operations: ["root_alias"] } }),
			call("error", 1, "bash", { runId: "run-a", status: "error", durationMs: 30, errorCode: "EXIT_1", truncated: true }),
			call("read", 0, "read", { runId: "run-b" }),
		];
		const report = aggregateTelemetry(records, { generatedAt: at(9) });
		expect(report.inventory).toEqual({ runs: 2, sessions: 2, calls: 3, tools: 2 });
		expect(report.tools.find((tool) => tool.tool === "bash")).toMatchObject({
			calls: 2,
			success_rate: { numerator: 1, samples: 2, value: 0.5 },
			duration_ms: { mean: 20, p50: 10, p95: 30 },
			error_codes: { EXIT_1: 1 },
			repair: { observed_calls: 1, repaired_rate: { value: 1 }, operations: { root_alias: 1 } },
		});

		const filtered = aggregateTelemetry(records, { query: { git_commits: ["commit-b"], git_dirty: [true], tools: ["read"] } });
		expect(filtered.inventory).toEqual({ runs: 1, sessions: 1, calls: 1, tools: 1 });
	});

	it("measures multi-file edit demand, partial failures, and possible call reduction", () => {
		const records = [
			call("a", 0, "edit", { batch: batch("batch-1", 3, 0), targets: [file("src/a.ts")], fields: { input_edit_count: 2, changed: true } }),
			call("b", 1, "edit", { batch: batch("batch-1", 3, 1), targets: [file("src/b.ts")], fields: { input_edit_count: 1, changed: true } }),
			call("c", 2, "edit", { batch: batch("batch-1", 3, 2), targets: [file("src/c.ts")], fields: { input_edit_count: 1, changed: false }, status: "error" }),
			call("d", 3, "edit", { fields: { input_edit_count: 1, changed: false }, targets: [file("src/d.ts")] }),
		];
		const report = analyzeEdits(records, new Map([["run-a", "/repo"]]));
		expect(report).toMatchObject({
			calls: 4,
			successful_calls: 3,
			failed_calls: 1,
			no_change_calls: 2,
			edits_per_call: { samples: 4, mean: 1.25 },
			batches: {
				batches: 1,
				multi_file_batches: 1,
				partial_failure_batches: 1,
				potential_call_reduction: 2,
				calls_per_batch: { mean: 3 },
				files_per_batch: { mean: 3 },
			},
		});
	});

	it("uses later target calls as a deliberately small candidate-ranking heuristic", () => {
		const candidates: Candidate[] = [
			{ kind: "file", value: "src/a.ts", rank: 1, sources: ["lexical"] },
			{ kind: "file", value: "src/b.ts", rank: 2, sources: ["repo-map-direct"] },
			{ kind: "file", value: "src/c.ts", rank: 3, sources: ["lsp-workspace-symbol", "lsp-reference"] },
		];
		const records = [
			call("grep", 0, "grep", { candidates, batch: batch("parallel", 2, 0) }),
			call("parallel-read", 1, "read", { targets: [file("src/a.ts")], batch: batch("parallel", 2, 1) }),
			call("read", 2, "read", { targets: [file("src/b.ts")] }),
			call("edit", 3, "edit", { targets: [file("src/c.ts")] }),
		];
		const report = analyzeCandidateRanking(records, new Map([["run-a", "/repo"]]));
		expect(report).toMatchObject({
			producer_calls: 1,
			candidates: 3,
			converted_candidates: 2,
			candidate_conversion_rate: 2 / 3,
			mrr: { samples: 1, value: 0.5 },
			by_source_family: {
				lsp: { candidates: 1, converted_candidates: 1, candidate_conversion_rate: 1, mrr: { value: 1 / 3 } },
				"repo-map": { candidates: 1, converted_candidates: 1, candidate_conversion_rate: 1, mrr: { value: 0.5 } },
			},
			downstream_consumers: { edit: 1, read: 1 },
		});
		expect(report.by_source["lsp-workspace-symbol"]).toMatchObject({
			producer_calls: 1,
			candidates: 1,
			converted_candidates: 1,
			downstream_consumers: { edit: 1 },
		});
		expect(report.by_source["lsp-workspace-symbol"]?.conversion_at_k).toEqual([
			{ k: 1, lists: 1, converted_lists: 0, rate: 0 },
			{ k: 3, lists: 1, converted_lists: 1, rate: 1 },
			{ k: 5, lists: 1, converted_lists: 1, rate: 1 },
			{ k: 10, lists: 1, converted_lists: 1, rate: 1 },
		]);
		expect(report.by_source["lsp-reference"]).toEqual(report.by_source["lsp-workspace-symbol"]);
		expect(report.by_tool.grep?.by_source_family).toEqual(report.by_source_family);
		expect(report.conversion_at_k).toEqual([
			{ k: 1, lists: 1, converted_lists: 0, rate: 0 },
			{ k: 3, lists: 1, converted_lists: 1, rate: 1 },
			{ k: 5, lists: 1, converted_lists: 1, rate: 1 },
			{ k: 10, lists: 1, converted_lists: 1, rate: 1 },
		]);
	});

	it("writes a compact JSON and HTML report", async () => {
		const input = path.join(temp.path, "generate-input");
		const output = path.join(temp.path, "generate-output");
		await mkdir(input, { recursive: true });
		await writeFile(path.join(input, "run.jsonl"), `${JSON.stringify(run("run-a", "commit-a"))}\n${JSON.stringify(call("edit", 0, "edit"))}\n`, "utf8");
		const result = await generateTelemetryReport({ inputDirectory: input, outputDirectory: output, generatedAt: at(9) });
		const json = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
		const html = await readFile(path.join(output, "report.html"), "utf8");
		expect(json.inventory.calls).toBe(1);
		expect(html).toContain("工具性能");
		expect(html).toContain("编辑调用：单文件与多文件");
		expect(html).toContain("按排名统计命中率");
		expect(html).not.toContain("<pre>");
		expect(html).not.toContain('"candidate_ranking"');
		expect(formatTelemetrySummary(result.report)).toContain("工具调用 1 次");
	});

	it("escapes report values and marks unavailable Git provenance as unknown", () => {
		const runWithoutGit: RunRecord = {
			type: "run",
			run_id: "run-a",
			at: at(0),
			session_id: "session-run-a",
			reason: "startup",
			cwd: "/repo",
		};
		const records: TelemetryRecord[] = [
			runWithoutGit,
			call("call", 0, "<script>alert(1)</script>", { status: "error" }),
		];
		const html = renderTelemetryHtml(aggregateTelemetry(records, { generatedAt: at(9) }));
		expect(html).toContain("未知");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain('class="rate-text bad"');
		expect(html).not.toContain("<script>alert(1)</script>");
	});

	it("renders the current-session report at narrow and wide widths", () => {
		const records: TelemetryRecord[] = [
			run("run-a", "commit-a"),
			call("grep", 0, "grep", { candidates: [
				{ kind: "file", value: "src/a.ts", rank: 1, sources: ["lsp-workspace-symbol"] },
			] }),
			call("read", 1, "read", { targets: [file("src/a.ts")] }),
		];
		const live = {
			report: aggregateTelemetry(records, { generatedAt: at(9) }),
			run_id: "run-a",
			session_id: "session-run-a",
			enabled: true,
			pending_calls: 1,
		};
		for (const width of [48, 100]) {
			const lines = renderLiveTelemetry(live, width);
			const rendered = lines.join("\n");
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(rendered).toContain("lsp");
			expect(rendered).toContain("进行中");
			expect(rendered).toContain("工具调用");
			expect(rendered).not.toContain("·");
		}

		const empty = renderLiveTelemetry({
			report: aggregateTelemetry([], { generatedAt: at(9) }),
			enabled: true,
			pending_calls: 0,
		}, 100).join("\n");
		expect(empty).toContain("MRR");
		expect(empty).toContain("无数据");
		expect(empty).not.toContain("0 / 0");
	});
});

interface CallOptions {
	runId?: string;
	status?: CallRecord["status"];
	durationMs?: number;
	outputChars?: number;
	errorCode?: string;
	truncated?: boolean;
	repair?: CallRecord["repair"];
	batch?: CallRecord["batch"];
	fields?: CallRecord["fields"];
	targets?: CallRecord["targets"];
	candidates?: CallRecord["candidates"];
}

function run(id: string, commit: string, dirty = false): RunRecord {
	return { type: "run", run_id: id, at: at(0), session_id: `session-${id}`, reason: "startup", cwd: "/repo", git: { commit, dirty } };
}

function call(id: string, index: number, tool: string, options: CallOptions = {}): CallRecord {
	return {
		type: "call",
		run_id: options.runId ?? "run-a",
		at: at(index + 1),
		call_id: id,
		call_index: index,
		tool,
		started_at: at(index + 1),
		ended_at: at(index + 1),
		duration_ms: options.durationMs ?? 1,
		status: options.status ?? "success",
		...(options.outputChars === undefined ? {} : { output_chars: options.outputChars }),
		...(options.errorCode === undefined ? {} : { error: { code: options.errorCode } }),
		...(options.truncated === undefined ? {} : { truncated: options.truncated }),
		...(options.repair === undefined ? {} : { repair: options.repair }),
		...(options.batch === undefined ? {} : { batch: options.batch }),
		...(options.fields === undefined ? {} : { fields: options.fields }),
		...(options.targets === undefined ? {} : { targets: options.targets }),
		...(options.candidates === undefined ? {} : { candidates: options.candidates }),
	};
}

function batch(id: string, size: number, index: number): NonNullable<CallRecord["batch"]> {
	return { id, size, index };
}

function file(value: string): NonNullable<CallRecord["targets"]>[number] {
	return { kind: "file", value };
}

function at(offset: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
}
