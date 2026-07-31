import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import type { CallRecord, Candidate, RunRecord, TelemetryRecord } from "../../src/telemetry/types.js";
import { aggregateTelemetry } from "../../src/telemetry-report/aggregate.js";
import { collectCandidateObservations } from "../../src/telemetry-report/analyzers/candidate-observations.js";
import { analyzeCandidateRanking } from "../../src/telemetry-report/analyzers/candidate-ranking.js";
import { analyzeEdits } from "../../src/telemetry-report/analyzers/edit.js";
import { analyzeGrep } from "../../src/telemetry-report/analyzers/grep.js";
import { analyzeSearchEffectiveness } from "../../src/telemetry-report/analyzers/search-effectiveness.js";
import { generateTelemetryReport } from "../../src/telemetry-report/command.js";
import { renderTelemetryHtml } from "../../src/telemetry-report/html.js";
import { renderLiveTelemetry } from "../../src/telemetry-report/tui/render-live.js";
import { readTelemetryDirectory } from "../../src/telemetry-report/read.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-telemetry-report-");

describe("telemetry report", () => {
	it("reads only the tolerant run/call format", async () => {
		const directory = path.join(temp.path, "read");
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, "run.jsonl"), [
			JSON.stringify(run("run-a", "commit-a")),
			JSON.stringify(call("call-a", 0, "grep", {
				repair: { status: "repaired", operations: ["split_path_list"] },
				candidates: [rankedCandidate("src/a.ts", 1, 3, 2, "mmr", 2.5, 0.01)],
			})),
			JSON.stringify({ ...call("bad", 1, "read"), status: "unfinished" }),
			JSON.stringify({ type: "tool", run_id: "run-a", at: at(0) }),
			"{bad-json",
			"",
		].join("\n"), "utf8");

		const result = await readTelemetryDirectory(directory);
		expect(result.records).toHaveLength(2);
		expect((result.records[1] as CallRecord).candidates?.[0]).toMatchObject({
			relevance_rank: 3,
			ranking_tier: 2,
			ranking_score: 2.5,
			ranking_aux_score: 0.01,
			selection: "mmr",
		});
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

	it("统计多 scope、scope 错误和路径列表 repair", () => {
		const records: TelemetryRecord[] = [
			run("run-a", "commit-a"),
			call("find-multi", 0, "find", {
				fields: { input_path_count: 2, scope_count: 3, scope_error_count: 1 },
				repair: { status: "repaired", operations: ["split_path_list"], fanout: { field: "path", count: 2, separator: "whitespace" } },
			}),
			call("grep-single", 1, "grep", { fields: { input_path_count: 1, scope_count: 1, scope_error_count: 0 } }),
		];
		const report = aggregateTelemetry(records, { generatedAt: at(9) });
		const find = report.tools.find((tool) => tool.tool === "find");
		expect(find).toMatchObject({
			input_path_count: { mean: 2 },
			scope_count: { mean: 3 },
			multi_scope_calls: 1,
			scope_error_calls: 1,
			scope_errors: 1,
			repair: {
			operations: { split_path_list: 1 },
			fanout_calls: 1,
			fanout_scopes: { mean: 2 },
			fanout_separators: { whitespace: 1 },
			},
		});
	});

	it("measures search work, candidate use, downstream actions, and candidate groups", () => {
		const records = [
			call("find", 0, "find", {
				fields: { scanned_file_count: 100 },
				candidates: [
					{ kind: "file", value: "src/a.ts", rank: 1, group: "primary", sources: ["lexical"] },
					{ kind: "file", value: "src/b.ts", rank: 2, group: "related", sources: ["lexical"] },
				],
			}),
			call("read", 1, "read", { targets: [file("src/a.ts")] }),
			call("edit", 2, "edit", { targets: [file("src/b.ts")] }),
			call("grep-empty", 3, "grep", { fields: { scanned_file_count: 25 } }),
			call("websearch", 4, "websearch", { candidates: [
				{ kind: "url", value: "https://example.test/a", rank: 1, group: "primary", sources: ["exa"] },
			] }),
			call("webfetch", 5, "webfetch", { targets: [{ kind: "url", value: "https://example.test/a" }] }),
		];
		const report = analyzeSearchEffectiveness(records, new Map([["run-a", "/repo"]]));
		expect(report).toMatchObject({
			calls: 3,
			calls_with_candidates: 2,
			calls_with_converted_candidates: 2,
			zero_candidate_calls: 1,
			calls_with_scanned_file_count: 2,
			scanned_files: 125,
			candidates: 3,
			converted_candidates: 3,
			candidate_conversion_rate: 1,
			downstream_inspections: 2,
			downstream_mutations: 1,
			downstream_other: 0,
			by_tool: {
				find: { calls: 1, calls_with_scanned_file_count: 1, scanned_files: 100, candidates: 2, converted_candidates: 2 },
				grep: { calls: 1, calls_with_scanned_file_count: 1, zero_candidate_calls: 1, candidates: 0, converted_candidates: 0 },
				websearch: { calls: 1, calls_with_scanned_file_count: 0, downstream_inspections: 1 },
			},
			by_group: {
				primary: { candidates: 2, converted_candidates: 2, downstream_inspections: 2 },
				related: { candidates: 1, converted_candidates: 1, downstream_mutations: 1 },
			},
		});
	});

	it("分析 grep 的 direct、related、空结果、内部容量和下游采用", () => {
		const records = [
			call("direct", 0, "grep", {
				fields: grepFields({
					text_hit_count: 6,
					returned_match_count: 2,
					returned_file_count: 2,
					returned_verified_candidate_count: 2,
					truncation_reasons: ["result_limit"],
					parsed_file_count: 2,
				}),
				candidates: [
					{ kind: "region", value: "src/direct-a.ts", rank: 1, group: "verified", sources: ["text-regex"], start_line: 1, end_line: 8 },
					{ kind: "region", value: "src/direct-b.ts", rank: 2, group: "verified", sources: ["text-regex"], start_line: 10, end_line: 18 },
				],
			}),
			call("read-direct", 1, "read", { targets: [file("src/direct-a.ts")] }),
			call("related", 2, "grep", {
				fields: grepFields({
					text_hit_count: 0,
					returned_match_count: 1,
					returned_file_count: 1,
					returned_related_candidate_count: 1,
					dropped_related_result_count: 3,
					dropped_related_anchor_count: 4,
					ast_skipped_oversized_file_count: 1,
				}),
				candidates: [
					{ kind: "region", value: "src/related.ts", rank: 1, group: "related", sources: ["lsp-symbol", "text-lexical"], start_line: 4, end_line: 12 },
				],
			}),
			call("read-related", 3, "read", { targets: [file("src/related.ts")] }),
			call("empty", 4, "grep", {
				fields: grepFields({
					text_hit_count: 0,
					returned_match_count: 0,
					returned_file_count: 0,
					returned_related_candidate_count: 0,
				}),
			}),
		];
		const report = analyzeGrep(records, cwd());
		expect(report).toMatchObject({
			calls: 3,
			successful_calls: 3,
			failed_calls: 0,
			execution_path_observed_calls: 3,
			direct_match: { numerator: 1, samples: 3 },
			related_fallback: { numerator: 1, samples: 3 },
			empty_result: { numerator: 1, samples: 3 },
			related_recovery: { numerator: 1, samples: 2, value: 0.5 },
			work: {
				text_hits: { samples: 3, mean: 2 },
				ast_augmented_calls: { numerator: 1, samples: 3 },
			},
			limits: { result: { numerator: 1, samples: 3 } },
			capacity: {
				dropped_related_results: { total: 3, calls: { numerator: 1, samples: 3 } },
				dropped_related_anchors: { total: 4, calls: { numerator: 1, samples: 3 } },
				ast_skipped_oversized_files: { total: 1, calls: { numerator: 1, samples: 3 } },
			},
			ranking: { observed_calls: 0, unobserved_calls: 3, by_algorithm: {} },
			by_result_kind: {
				verified: { calls: 1, candidates: 2, pre_refinement_adoption: { numerator: 1, samples: 1 } },
				related: { calls: 1, candidates: 1, pre_refinement_adoption: { numerator: 1, samples: 1 } },
			},
			by_source: {
				"lsp-symbol": { candidates: 1, pre_refinement_adoption: { numerator: 1, samples: 1 } },
			},
		});
		expect(report.findings.map((finding) => finding.code)).toEqual([
			"incomplete_ranking_facts",
			"related_fallback_recovery",
			"related_fallback_follow_up",
			"result_limit_pressure",
			"related_limit_pressure",
			"ast_size_limit_pressure",
			"lsp_assistance_observed",
		]);

		expect(aggregateTelemetry([run("run-a", "commit-a"), ...records], { generatedAt: at(9) }).grep.related_recovery)
			.toMatchObject({ numerator: 1, samples: 2 });
	});

	it("样本足够时将持续空结果提升为 grep finding", () => {
		const records = Array.from({ length: 5 }, (_, index) =>
			call(`empty-${index}`, index, "grep", { fields: grepFields() }));
		const report = analyzeGrep(records, cwd());
		expect(report.empty_result).toMatchObject({ numerator: 5, samples: 5, value: 1 });
		expect(report.findings).toContainEqual(expect.objectContaining({
			code: "frequent_empty_results",
			severity: "warning",
			evidence: { numerator: 5, samples: 5, value: 1 },
		}));
	});

	it("按排序算法展示 Hit、MRR、nDCG、tier、选择阶段、分数和多样性", () => {
		const records = [
			call("rank-v1", 0, "grep", {
				runId: "rank-v1",
				fields: grepFields({
					returned_match_count: 2,
					returned_file_count: 2,
					ranking_algorithm: "tier-bm25f-rrf-mmr-v1",
					ranking_candidate_count: 10,
					ranking_eligible_candidate_count: 6,
					ranking_selected_candidate_count: 2,
					ranking_head_size: 1,
					ranking_tier_count: 2,
					ranking_top_tier_candidate_count: 1,
					ranking_mmr_selected_count: 1,
					ranking_mmr_replacement_count: 1,
					ranking_relevance_prefix_file_count: 1,
					ranking_selected_file_count: 2,
				}),
				candidates: [
					rankedCandidate("src/head.ts", 1, 1, 1, "head", 5, 0.02),
					rankedCandidate("src/mmr.ts", 2, 5, 2, "mmr", 2, 0.01),
				],
			}),
			call("rank-v1-read", 1, "read", { runId: "rank-v1", targets: [file("src/mmr.ts")] }),
			call("rank-v1-edit", 2, "edit", { runId: "rank-v1", targets: [file("src/mmr.ts")] }),
			call("rank-v2", 0, "grep", {
				runId: "rank-v2",
				fields: grepFields({
					returned_match_count: 1,
					returned_file_count: 1,
					ranking_algorithm: "experimental-v2",
					ranking_candidate_count: 4,
					ranking_eligible_candidate_count: 4,
					ranking_selected_candidate_count: 1,
					ranking_head_size: 1,
					ranking_tier_count: 1,
					ranking_top_tier_candidate_count: 4,
					ranking_mmr_selected_count: 0,
					ranking_mmr_replacement_count: 0,
					ranking_relevance_prefix_file_count: 1,
					ranking_selected_file_count: 1,
				}),
				candidates: [rankedCandidate("src/v2.ts", 1, 1, 1, "head", 7, 0)],
			}),
			call("rank-v2-read", 1, "read", { runId: "rank-v2", targets: [file("src/v2.ts")] }),
		];
		const cwdByRun = new Map([["rank-v1", "/repo"], ["rank-v2", "/repo"]]);
		const report = analyzeGrep(records, cwdByRun);

		expect(report.ranking).toMatchObject({
			observed_calls: 2,
			unobserved_calls: 0,
			by_algorithm: {
				"tier-bm25f-rrf-mmr-v1": {
					calls: 1,
					candidate_pool: { mean: 10 },
					eligible_candidates: { mean: 6 },
					selected_candidates: { mean: 2 },
					selection_changed: { numerator: 1, samples: 1, value: 1 },
					file_diversity_gain: { mean: 1 },
					immediate: { mrr: { value: 0.5 } },
					by_tier: {
						"2": {
							candidates: 1,
							immediate_adoption: { numerator: 1, samples: 1 },
							productive_adoption: { numerator: 1, samples: 1 },
							relevance_rank: { mean: 5 },
							rank_promotion: { mean: 3 },
							productive_rank_promotion: { mean: 3 },
							productive_primary_score: { mean: 2 },
						},
					},
					by_selection: {
						mmr: {
							candidates: 1,
							immediate_adoption: { numerator: 1, samples: 1 },
						},
					},
				},
				"experimental-v2": {
					calls: 1,
					candidate_pool: { mean: 4 },
					selection_changed: { numerator: 0, samples: 1, value: 0 },
				},
			},
		});
		expect(report.ranking.by_algorithm["tier-bm25f-rrf-mmr-v1"]?.immediate.ndcg_at_k
			.find((item) => item.k === 10)?.value).toBeCloseTo(1 / Math.log2(3));

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

	it("normalizes regions and only adopts the intersecting region", () => {
		const records = [
			call("grep", 0, "grep", { candidates: [
				candidate("src/a.ts", 3, ["lexical"], 10, 20),
				candidate("src/a.ts", 1, ["lsp-reference"], 10, 20),
				candidate("src/a.ts", 2, ["lsp-workspace-symbol"], 30, 40),
			] }),
			call("read", 1, "read", { targets: [region("src/a.ts", 15, 16)] }),
		];
		const observed = collectCandidateObservations(records, cwd());
		const report = analyzeCandidateRanking(records, cwd());
		expect(report.file_level).toMatchObject({ exposures: 1, actions: { inspection: 1 } });
		expect(report.region_level).toMatchObject({
			exposures: 2,
			immediate: { adopted_lists: 1, unknown_lists: 0 },
			broad: { adopted_lists: 1 },
		});
		expect(observed.region_observations.filter((item) => item.consumer !== undefined)).toHaveLength(1);
		expect(observed.region_observations.find((item) => item.consumer !== undefined)?.candidate).toMatchObject({
			start_line: 10,
			end_line: 20,
			rank: 1,
			sources: ["lexical", "lsp-reference"],
		});
	});

	it("treats a whole-file read as file adoption and unknown region adoption", () => {
		const report = analyzeCandidateRanking([
			call("grep", 0, "grep", { candidates: [candidate("src/a.ts", 1, ["lexical"], 10, 20)] }),
			call("read", 1, "read", { targets: [file("src/a.ts")] }),
		], cwd());
		expect(report.file_level.immediate.adopted_lists).toBe(1);
		expect(report.region_level.immediate).toMatchObject({ adopted_lists: 0, unknown_lists: 1 });
		expect(report.region_level.actions.inspection).toBe(0);
	});

	it("attributes one consumer to only the most recent producer", () => {
		const records = [
			call("first", 0, "find", { candidates: [candidate("src/a.ts", 1, ["lexical"])] }),
			call("second", 1, "grep", { candidates: [candidate("src/a.ts", 3, ["lsp-workspace-symbol"])] }),
			call("read", 2, "read", { targets: [file("src/a.ts")] }),
		];
		const observed = collectCandidateObservations(records, cwd());
		expect(observed.attributions).toHaveLength(1);
		expect(observed.attributions[0]?.producer.call_id).toBe("second");
		const report = analyzeCandidateRanking(records, cwd());
		expect(report.file_level.broad).toMatchObject({ lists: 2, adopted_lists: 1 });
	});

	it("excludes failed and same-batch consumers", () => {
		const records = [
			call("grep", 0, "grep", { candidates: [candidate("src/a.ts", 1, ["lexical"])], batch: batch("parallel", 2, 0) }),
			call("parallel", 1, "read", { targets: [file("src/a.ts")], batch: batch("parallel", 2, 1) }),
			call("failed", 2, "read", { targets: [file("src/a.ts")], status: "error" }),
		];
		const report = analyzeCandidateRanking(records, cwd());
		expect(report.file_level.immediate.adopted_lists).toBe(0);
		expect(report.file_level.broad.adopted_lists).toBe(0);
	});

	it("records search abandonment before refinement", () => {
		const report = analyzeCandidateRanking([
			call("find", 0, "find", { candidates: [candidate("src/a.ts", 1, ["lexical"])] }),
			call("grep", 1, "grep"),
			call("read", 2, "read", { targets: [file("src/a.ts")] }),
		], cwd());
		expect(report.file_level).toMatchObject({
			search_abandonment: 1,
			search_abandonment_rate: 1,
			pre_refinement: { adopted_lists: 0 },
			broad: { adopted_lists: 1 },
		});
	});

	it("distinguishes novel and prior-known candidate files", () => {
		const report = analyzeCandidateRanking([
			call("prior", 0, "read", { targets: [file("src/known.ts")] }),
			call("find", 1, "find", { candidates: [
				candidate("src/known.ts", 1, ["lexical"]),
				candidate("src/novel.ts", 2, ["lexical"]),
			] }),
			call("read", 2, "read", { targets: [file("src/novel.ts")] }),
		], cwd());
		expect(report.file_level.novelty).toEqual({
			novel_exposures: 1,
			novel_exposure_rate: 0.5,
			novel_immediate_adopted: 1,
			novel_immediate_adoption_rate: 1,
			novel_productive: 0,
			novel_productive_adoption_rate: 0,
			prior_known_exposures: 1,
			prior_known_rate: 0.5,
		});
	});

	it("reports source contribution bounds and read-to-edit productivity", () => {
		const report = analyzeCandidateRanking([
			call("grep", 0, "grep", { outputChars: 1000, candidates: [
				candidate("src/a.ts", 1, ["lexical", "lsp-workspace-symbol"]),
				candidate("src/b.ts", 2, ["lsp-reference"]),
			] }),
			call("read-a", 1, "read", { targets: [file("src/a.ts")] }),
			call("edit-a", 2, "edit", { targets: [file("src/a.ts")] }),
			call("edit-b", 3, "write", { targets: [file("src/b.ts")] }),
		], cwd());
		expect(report.file_level.actions).toEqual({ inspection: 1, mutation: 2, productive: 2, inspection_only: 0 });
		expect(report.by_source["lsp-workspace-symbol"]).toMatchObject({
			participation_exposures: 1,
			exclusive_exposures: 0,
			participation_productive: 1,
			exclusive_productive: 0,
			redundancy_rate: 1,
		});
		expect(report.by_source_family["lsp"]).toMatchObject({
			participation_exposures: 2,
			exclusive_exposures: 1,
			participation_productive: 2,
			exclusive_productive: 1,
			redundancy_rate: 0.5,
		});
		expect(report.output_efficiency).toMatchObject({
			immediate_adopted_lists_per_1000_chars: 1,
			productive_adopted_lists_per_1000_chars: 1,
			chars_per_productive_adopted_list: 1000,
			no_action_output_share: 0,
		});
	});

	it("computes output-character efficiency and no-action share per producer tool", () => {
		const report = analyzeCandidateRanking([
			call("productive", 0, "find", { outputChars: 1000, candidates: [candidate("src/a.ts", 1, ["lexical"])] }),
			call("edit", 1, "edit", { targets: [file("src/a.ts")] }),
			call("no-action", 2, "find", { outputChars: 1000, candidates: [candidate("src/b.ts", 1, ["lexical"])] }),
		], cwd());
		expect(report.output_efficiency).toMatchObject({
			output_chars: 2000,
			immediate_adopted_lists_per_1000_chars: 0.5,
			productive_adopted_lists_per_1000_chars: 0.5,
			chars_per_productive_adopted_list: 2000,
			no_action_output_chars: 1000,
			no_action_output_share: 0.5,
		});
		expect(report.by_tool.find?.output_efficiency).toEqual(report.output_efficiency);
	});

	it("computes Hit@K, MRR, nDCG, and adoption retention from unique events", () => {
		const report = analyzeCandidateRanking([
			call("find", 0, "find", { candidates: [
				candidate("src/one.ts", 1, ["lexical"]),
				candidate("src/two.ts", 2, ["lexical"]),
				candidate("src/four.ts", 4, ["lexical"]),
				candidate("src/six.ts", 6, ["lexical"]),
			] }),
			call("read-four", 1, "read", { targets: [file("src/four.ts")] }),
			call("read-two", 2, "read", { targets: [file("src/two.ts")] }),
			call("edit-six", 3, "edit", { targets: [file("src/six.ts")] }),
		], cwd());
		expect(report.file_level.immediate.hit_at_k.map((item) => item.converted_lists)).toEqual([0, 0, 1, 1]);
		expect(report.file_level.immediate.mrr.value).toBe(0.25);
		expect(report.file_level.immediate.ndcg_at_k.map((item) => item.value)).toEqual([
			0,
			0,
			1 / Math.log2(5),
			1 / Math.log2(5),
		]);
		expect(report.file_level.pre_refinement.mrr.value).toBe(0.5);
		expect(report.file_level.pre_refinement.retention_at_k.map((item) => item.rate)).toEqual([0, 1 / 3, 2 / 3, 1]);
		expect(report.file_level.productive.hit_at_k.map((item) => item.converted_lists)).toEqual([0, 0, 0, 1]);
		expect(report.file_level.productive.mrr.value).toBe(1 / 6);
	});

	it("keeps broad adoption bounded by ten calls and five minutes", () => {
		const records = [
			call("edge", 0, "find", { runId: "edge", candidates: [candidate("src/a.ts", 1, ["lexical"])] }),
			...Array.from({ length: 9 }, (_, index) => call(`edge-gap-${index}`, index + 1, "bash", { runId: "edge" })),
			call("edge-read", 10, "read", { runId: "edge", targets: [file("src/a.ts")] }),
			call("late-call", 0, "find", { runId: "late-call", candidates: [candidate("src/b.ts", 1, ["lexical"])] }),
			...Array.from({ length: 10 }, (_, index) => call(`late-gap-${index}`, index + 1, "bash", { runId: "late-call" })),
			call("late-read", 11, "read", { runId: "late-call", targets: [file("src/b.ts")] }),
			call("late-time", 0, "find", { runId: "late-time", atOffset: 0, candidates: [candidate("src/c.ts", 1, ["lexical"])] }),
			call("timed-read", 1, "read", { runId: "late-time", atOffset: 301, targets: [file("src/c.ts")] }),
		];
		const report = analyzeCandidateRanking(records, new Map([["edge", "/repo"], ["late-call", "/repo"], ["late-time", "/repo"]]));
		expect(report.file_level.broad).toMatchObject({ lists: 3, adopted_lists: 1 });
		expect(report.converted_candidates).toBe(1);
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
		expect(html.length).toBeGreaterThan(0);
		expect(html).not.toContain("<pre>");
		expect(html).not.toContain('"candidate_ranking"');
		expect(result.report.inventory.calls).toBe(1);
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
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
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
		}

		const empty = renderLiveTelemetry({
			report: aggregateTelemetry([], { generatedAt: at(9) }),
			enabled: true,
			pending_calls: 0,
		}, 100).join("\n");
		expect(empty).not.toMatch(/undefined|null/u);
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
	atOffset?: number;
}

function run(id: string, commit: string, dirty = false): RunRecord {
	return { type: "run", run_id: id, at: at(0), session_id: `session-${id}`, reason: "startup", cwd: "/repo", git: { commit, dirty } };
}

function call(id: string, index: number, tool: string, options: CallOptions = {}): CallRecord {
	return {
		type: "call",
		run_id: options.runId ?? "run-a",
		at: at(options.atOffset ?? index + 1),
		call_id: id,
		call_index: index,
		tool,
		started_at: at(options.atOffset ?? index + 1),
		ended_at: at(options.atOffset ?? index + 1),
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

function region(value: string, startLine: number, endLine: number): NonNullable<CallRecord["targets"]>[number] {
	return { kind: "region", value, start_line: startLine, end_line: endLine };
}

function candidate(value: string, rank: number, sources: string[], startLine?: number, endLine?: number): Candidate {
	return {
		kind: startLine === undefined && endLine === undefined ? "file" : "region",
		value,
		rank,
		sources,
		...(startLine === undefined ? {} : { start_line: startLine }),
		...(endLine === undefined ? {} : { end_line: endLine }),
	};
}

function rankedCandidate(
	value: string,
	rank: number,
	relevanceRank: number,
	tier: number,
	selection: string,
	primaryScore: number,
	auxiliaryScore: number,
): Candidate {
	return {
		...candidate(value, rank, ["text-regex"]),
		relevance_rank: relevanceRank,
		ranking_tier: tier,
		ranking_score: primaryScore,
		ranking_aux_score: auxiliaryScore,
		selection,
	};
}

function grepFields(overrides: NonNullable<CallRecord["fields"]> = {}): NonNullable<CallRecord["fields"]> {
	return {
		status: "success",
		searched_file_count: 10,
		searched_byte_count: 1_000,
		text_hit_count: 0,
		parsed_file_count: 0,
		returned_match_count: 0,
		returned_file_count: 0,
		approx_token_count: 20,
		dropped_text_hit_count: 0,
		dropped_related_anchor_count: 0,
		dropped_related_result_count: 0,
		ast_skipped_oversized_file_count: 0,
		returned_verified_candidate_count: 0,
		returned_related_candidate_count: 0,
		truncation_reasons: [],
		...overrides,
	};
}

function cwd(): ReadonlyMap<string, string> {
	return new Map([["run-a", "/repo"]]);
}

function at(offset: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
}
