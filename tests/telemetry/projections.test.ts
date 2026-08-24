import { describe, expect, it } from "vitest";

import { bashTelemetry } from "../../src/bash-tool/telemetry.js";
import type { BashParams, BashToolDetails } from "../../src/bash-tool/types.js";
import { editTelemetry } from "../../src/file-tools/telemetry/edit.js";
import { findTelemetry } from "../../src/file-tools/telemetry/find.js";
import { grepTelemetry } from "../../src/file-tools/telemetry/grep.js";
import { readTelemetry } from "../../src/file-tools/telemetry/read.js";
import { writeTelemetry } from "../../src/file-tools/telemetry/write.js";
import type { ToolOutcome } from "../../src/file-tools/shared/result.js";
import type { ReadFileSuccess, ReadParams } from "../../src/file-tools/read/types.js";
import type { EditParams, EditSuccess } from "../../src/file-tools/edit/types.js";
import type { FindDetails, FindParams } from "../../src/file-tools/find/types.js";
import type { GrepParams, GrepSuccess } from "../../src/file-tools/grep/types.js";
import type { WriteParams, WriteSuccess } from "../../src/file-tools/write/types.js";
import { safeProject } from "../../src/telemetry/projection.js";
import type { TelemetryFacts, ToolTelemetry } from "../../src/telemetry/types.js";
import { webFetchTelemetry } from "../../src/web-tools/telemetry/webfetch.js";
import { webSearchTelemetry } from "../../src/web-tools/telemetry/websearch.js";
import type { WebFetchDetails, WebFetchParams, WebSearchDetails, WebSearchParams } from "../../src/web-tools/core/types.js";

describe("tool telemetry projections", () => {
	it("bounds invalid and oversized facts without throwing", () => {
		const projected = safeProject(() => fixture<TelemetryFacts>({
			fields: { body: "x".repeat(1_000), invalid: { nested: true } },
			targets: Array.from({ length: 70 }, (_, index) => ({ kind: "file", value: `src/${index}.ts` })),
			candidates: [{ kind: "file", value: "src/a.ts", rank: 1, sources: ["lsp"] }],
		}));
		expect(projected.error).toBe("invalid_projection");
		expect(projected.limited).toBe(true);
		expect(projected.facts.fields).toMatchObject({ body_chars: 1_000 });
		expect(projected.facts.fields).not.toHaveProperty("body");
		expect(projected.facts.targets).toHaveLength(64);
	});

	it("edit records decision metrics and path but no replacement bodies", () => {
		const params: EditParams = { path: "src/a.ts", edits: [{ old: "secret old", new: "secret new" }, { old: "x", new: "y" }] };
		const input = inputFacts(editTelemetry, params);
		const output = resultFacts(editTelemetry, params, fixture<ToolOutcome<EditSuccess>>({
			status: "applied", path: "src/a.ts", replacements: 2, old_version: "old", new_version: "new", old_size_bytes: 10, new_size_bytes: 20, diff: "secret diff",
		}));
		expect(input).toMatchObject({ fields: { input_edit_count: 2, input_old_chars: 11, input_new_chars: 11 }, targets: [{ kind: "file", value: "src/a.ts" }] });
		expect(output.fields).toMatchObject({ status: "applied", replacement_count: 2, changed: true });
		expectNoBody(input, output);
	});

	it("find and grep preserve displayed candidate order and ranking sources", () => {
		const findParams = fixture<FindParams>({ path: ["src", "tests"], query: "private symbol" });
		const findInput = inputFacts(findTelemetry, findParams);
		const findOutput = resultFacts(findTelemetry, findParams, fixture<FindDetails>({
			status: "ok",
			paths: ["src"],
			scope_errors: [{ path: "missing", error: { code: "PATH_NOT_FOUND", message: "missing" } }],
			displayed_matches: [{ path: "src/a.ts", kind: "file" }],
			total_candidates: 4,
			returned_matches: 1,
			truncated_by: ["depth_limit"],
		}));
		expect(findInput.fields).toMatchObject({ input_query_chars: 14, input_path_count: 2 });
		expect(findInput.targets).toEqual([{ kind: "directory", value: "src" }, { kind: "directory", value: "tests" }]);
		expect(JSON.stringify(findInput)).not.toContain("private symbol");
		expect(findOutput.fields).toMatchObject({ scope_count: 2, scope_error_count: 1, truncated: true });
		expect(findOutput.candidates).toEqual([
			{ kind: "file", value: "src/a.ts", rank: 1, group: "primary", sources: ["fuzzy"] },
		]);

		const grepParams = fixture<GrepParams>({ path: ["src", "tests"], query: "needle" });
		const grepInput = inputFacts(grepTelemetry, grepParams);
		expect(grepInput.fields).toMatchObject({ input_path_count: 2 });
		expect(grepInput.targets).toEqual([{ kind: "path", value: "src" }, { kind: "path", value: "tests" }]);
		const grepOutput = resultFacts(grepTelemetry, grepParams, fixture<ToolOutcome<GrepSuccess>>({
			status: "success",
			query_mode: "regex",
			path: "src",
			paths: ["src", "tests"],
			total_candidates: 3,
			returned_regions: 2,
			returned_files: 2,
			approx_tokens: 120,
			stats: {
				traversed_entries: 20,
				searched_files: 10,
				searched_bytes: 2000,
				text_hits: 6,
				parsed_files: 4,
				dropped_text_hits: 7,
				dropped_related_anchors: 11,
				dropped_related_results: 5,
				ast_skipped_oversized_files: 2,
			},
			truncated_by: ["result_limit"],
			regions: [
				{ path: "src/c.ts", start_line: 2, end_line: 4, query_match: "verified", sources: ["text-regex"] },
				{ path: "src/d.ts", start_line: 6, end_line: 8, query_match: "semantic", sources: ["lsp-symbol"] },
			],
			ranking: {
				algorithm: "tier-bm25f-rrf-mmr-v1",
				candidate_count: 8,
				eligible_candidate_count: 3,
				selected_candidate_count: 2,
				relevance_head_size: 1,
				tier_count: 2,
				top_tier_candidate_count: 1,
				mmr_selected_count: 1,
				mmr_replacement_count: 1,
				relevance_prefix_file_count: 1,
				selected_file_count: 2,
				regions: [
					{ relevance_rank: 1, tier: 1, primary_score: 4.5, auxiliary_score: 0.02, selection: "head" },
					{ relevance_rank: 3, tier: 2, primary_score: 2.5, auxiliary_score: 0.01, selection: "mmr" },
				],
			},
		}));
		expect(grepOutput.fields).toMatchObject({
			query_mode: "regex",
			truncated: true,
			truncation_reasons: ["result_limit"],
			total_candidate_count: 3,
			returned_match_count: 2,
			returned_file_count: 2,
			traversed_entry_count: 20,
			searched_file_count: 10,
			searched_byte_count: 2000,
			text_hit_count: 6,
			parsed_file_count: 4,
			dropped_text_hit_count: 7,
			dropped_related_anchor_count: 11,
			dropped_related_result_count: 5,
			ast_skipped_oversized_file_count: 2,
			returned_verified_candidate_count: 1,
			returned_related_candidate_count: 1,
			approx_token_count: 120,
			ranking_algorithm: "tier-bm25f-rrf-mmr-v1",
			ranking_candidate_count: 8,
			ranking_eligible_candidate_count: 3,
			ranking_selected_candidate_count: 2,
			ranking_head_size: 1,
			ranking_tier_count: 2,
			ranking_top_tier_candidate_count: 1,
			ranking_mmr_selected_count: 1,
			ranking_mmr_replacement_count: 1,
			ranking_relevance_prefix_file_count: 1,
			ranking_selected_file_count: 2,
		});
		expect(grepOutput.candidates).toEqual([
			{
				kind: "region", value: "src/c.ts", rank: 1, group: "verified", start_line: 2, end_line: 4,
				sources: ["text-regex"], relevance_rank: 1, ranking_tier: 1, ranking_score: 4.5,
				ranking_aux_score: 0.02, selection: "head",
			},
			{
				kind: "region", value: "src/d.ts", rank: 2, group: "related", start_line: 6, end_line: 8,
				sources: ["lsp-symbol"], relevance_rank: 3, ranking_tier: 2, ranking_score: 2.5,
				ranking_aux_score: 0.01, selection: "mmr",
			},
		]);
	});

	it("read and write expose targets while hashing content", () => {
		const readParams = fixture<ReadParams>({ path: "src/a.ts", lines: "2-5" });
		const readInput = inputFacts(readTelemetry, readParams);
		expect(readInput.fields).toMatchObject({ input_lines: "2-5" });
		expect(readInput.targets).toEqual([{ kind: "region", value: "src/a.ts", start_line: 2, end_line: 5 }]);
		const readResult = resultFacts(readTelemetry, readParams, fixture<ToolOutcome<ReadFileSuccess>>({ status: "ok", path: "src/a.ts", content: "private body" }));
		expectNoBody(readResult);

		const pdfParams = fixture<ReadParams>({ path: "docs/spec.pdf", pages: "4-" });
		const pdfInput = inputFacts(readTelemetry, pdfParams);
		expect(pdfInput.fields).toMatchObject({ input_pages: "4-" });
		expect(pdfInput.targets).toEqual([{ kind: "file", value: "docs/spec.pdf" }]);
		const pdfResult = resultFacts(readTelemetry, pdfParams, fixture<ToolOutcome<ReadFileSuccess>>({
			path: "docs/spec.pdf",
			media_type: "pdf",
			total_pages: 30,
			truncated: false,
			metadata: { title: "private title", author: "private author" },
			pages: [
				{ number: 4, image: { data: "private-base64-1", mime_type: "image/png" } },
				{ number: 5, image: { data: "private-base64-2", mime_type: "image/png" } },
			],
		}));
		expect(pdfResult.fields).toMatchObject({
			media_type: "pdf",
			total_page_count: 30,
			returned_page_count: 2,
			truncated: false,
		});
		expectNoBody(pdfInput, pdfResult);

		const writeParams = fixture<WriteParams>({ path: "src/new.ts", content: "private content" });
		const writeInput = inputFacts(writeTelemetry, writeParams);
		expect(writeInput.fields).toMatchObject({ input_content_chars: 15, input_content_lines: 1 });
		expect(writeInput.targets).toEqual([{ kind: "file", value: "src/new.ts" }]);
		expect(JSON.stringify(writeInput)).not.toContain("private content");
		resultFacts(writeTelemetry, writeParams, fixture<ToolOutcome<WriteSuccess>>({ status: "written", path: "src/new.ts" }));
	});

	it("web search links ranked URLs to later fetch targets without storing the query", () => {
		const searchParams = fixture<WebSearchParams>({ query: "private query", limit: 5 });
		const input = inputFacts(webSearchTelemetry, searchParams);
		const output = resultFacts(webSearchTelemetry, searchParams, fixture<WebSearchDetails>({
			status: "success", provider: "brave_api", query_type: "general",
			attempts: [
				{ provider: "brave_api", status: "success", duration_ms: 12, quality: "partial" },
				{ provider: "tavily", status: "failed", duration_ms: 8, error: { code: "TIMEOUT", message: "timeout" } },
			],
			results: [{ title: "A", url: "https://example.com/a", rank: 3, provenance: [{ provider: "brave_api", rank: 1 }, { provider: "tavily", rank: 2 }] }],
		}));
		expect(input.fields).toMatchObject({ input_query_chars: 13, input_limit: 5 });
		expect(JSON.stringify(input)).not.toContain("private query");
		expect(output.fields).toMatchObject({
			query_type: "general",
			fallback: true,
			first_call_accepted: false,
			provider_latencies: ["brave_api:12", "tavily:8"],
			provider_errors: ["tavily:TIMEOUT"],
		});
		expect(output.candidates).toEqual([{ kind: "url", value: "https://example.com/a", rank: 1, group: "primary", sources: ["brave_api", "tavily"] }]);

		const fetchParams = fixture<WebFetchParams>({ url: "https://example.com/a" });
		expect(inputFacts(webFetchTelemetry, fetchParams).targets).toEqual([{ kind: "url", value: "https://example.com/a" }]);
		resultFacts(webFetchTelemetry, fetchParams, fixture<WebFetchDetails>({ status: "ok", final_url: "https://example.com/a" }));
	});

	it("bash stores command shape and outcome, not command output", () => {
		const params = fixture<BashParams>({ command: "printf secret", timeout: 10 });
		const input = inputFacts(bashTelemetry, params);
		const output = resultFacts(bashTelemetry, params, fixture<BashToolDetails>({
			status: "completed", exit_code: 0, output_state: "complete", output_format: "text", capture_complete: true,
			total_lines: 1, returned_lines: 1, total_bytes: 6, returned_bytes: 6, output: "secret",
		}));
		expect(input.fields).toMatchObject({ input_command_chars: 13, input_timeout_seconds: 10 });
		expect(output.fields).toMatchObject({ status: "completed", exit_code: 0 });
		expectNoBody(input, output);
	});
});

function inputFacts<TParams, TDetails>(telemetry: ToolTelemetry<TParams, TDetails>, params: TParams): TelemetryFacts {
	return telemetry.input?.(params) ?? {};
}

function resultFacts<TParams, TDetails>(telemetry: ToolTelemetry<TParams, TDetails>, params: TParams, details: TDetails): TelemetryFacts {
	return telemetry.result?.(params, details) ?? {};
}

function expectNoBody(...facts: readonly TelemetryFacts[]): void {
	const serialized = JSON.stringify(facts);
	for (const text of [
		"secret old", "secret new", "secret diff", "private body", "private title", "private author",
		"private-base64", "printf secret", '"output":"secret"',
	]) {
		expect(serialized).not.toContain(text);
	}
}

function fixture<T>(value: unknown): T {
	return value as T;
}
