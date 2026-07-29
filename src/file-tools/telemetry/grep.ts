import { fields } from "../../telemetry/projection.js";
import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { Candidate, Fields } from "../../telemetry/types.js";
import type { GrepParams, GrepSuccess } from "../grep/types.js";
import type { ToolOutcome } from "../shared/result.js";
import {
	number,
	projectFileInput,
	record,
	sourceLabels,
	string,
} from "./common.js";

export const grepTelemetry = defineToolTelemetry<GrepParams, ToolOutcome<GrepSuccess>>({
	input: projectFileInput(["query", "path", "glob"], "path", { pathList: true }),
	result(_params, result) {
		const details = record(result.details);
		return { fields: grepResultFields(details), candidates: grepCandidates(details) };
	},
});

function grepResultFields(details: Record<string, unknown>): Fields {
	const stats = record(details["stats"]);
	const ranking = record(details["ranking"]);
	const errorDetails = record(record(details["error"])["details"]);
	const scopeErrors = arrayLength(details["scope_errors"]) ?? arrayLength(errorDetails["scope_errors"]);
	const paths = stringList(details["paths"]) ?? stringList(errorDetails["paths"]);
	const truncationReasons = stringList(details["truncated_by"]);
	return fields({
		status: string(details["status"]),
		error_code: string(record(details["error"])["code"]),
		truncated: truncationReasons !== undefined && truncationReasons.length > 0 ? true : undefined,
		truncation_reasons: truncationReasons,
		total_candidate_count: number(details["total_candidates"]),
		returned_match_count: number(details["returned_regions"]),
		returned_file_count: number(details["returned_files"]),
		approx_token_count: number(details["approx_tokens"]),
		traversed_entry_count: number(stats["traversed_entries"]),
		searched_file_count: number(stats["searched_files"]),
		searched_byte_count: number(stats["searched_bytes"]),
		text_hit_count: number(stats["text_hits"]),
		parsed_file_count: number(stats["parsed_files"]),
		dropped_text_hit_count: number(stats["dropped_text_hits"]),
		dropped_related_anchor_count: number(stats["dropped_related_anchors"]),
		dropped_related_result_count: number(stats["dropped_related_results"]),
		ast_skipped_oversized_file_count: number(stats["ast_skipped_oversized_files"]),
		returned_verified_candidate_count: regionCount(details["regions"], "verified"),
		returned_related_candidate_count: regionCount(details["regions"], "semantic"),
		skipped_file_count: skippedCount(stats["skipped_files"]),
		scope_count: paths === undefined ? (typeof details["path"] === "string" ? 1 + (scopeErrors ?? 0) : undefined) : paths.length + (scopeErrors ?? 0),
		scope_error_count: scopeErrors,
		ranking_algorithm: string(ranking["algorithm"]),
		ranking_candidate_count: number(ranking["candidate_count"]),
		ranking_eligible_candidate_count: number(ranking["eligible_candidate_count"]),
		ranking_selected_candidate_count: number(ranking["selected_candidate_count"]),
		ranking_head_size: number(ranking["relevance_head_size"]),
		ranking_tier_count: number(ranking["tier_count"]),
		ranking_top_tier_candidate_count: number(ranking["top_tier_candidate_count"]),
		ranking_mmr_selected_count: number(ranking["mmr_selected_count"]),
		ranking_mmr_replacement_count: number(ranking["mmr_replacement_count"]),
		ranking_relevance_prefix_file_count: number(ranking["relevance_prefix_file_count"]),
		ranking_selected_file_count: number(ranking["selected_file_count"]),
	});
}

function grepCandidates(details: Record<string, unknown>): Candidate[] {
	const result: Candidate[] = [];
	if (!Array.isArray(details["regions"])) return result;
	const ranking = record(details["ranking"]);
	const rankingRegions = Array.isArray(ranking["regions"]) ? ranking["regions"].map(record) : [];
	for (const [index, value] of details["regions"].entries()) {
		const item = record(value);
		const path = string(item["path"]);
		if (path === undefined) continue;
		const group = item["query_match"] === "semantic" ? "related" : "verified";
		const rankingRegion = rankingRegions[index] ?? {};
		const relevanceRank = number(rankingRegion["relevance_rank"]);
		const tier = number(rankingRegion["tier"]);
		const primaryScore = number(rankingRegion["primary_score"]);
		const auxiliaryScore = number(rankingRegion["auxiliary_score"]);
		const selection = string(rankingRegion["selection"]);
		result.push({
			kind: "region",
			value: path,
			rank: result.length + 1,
			group,
			sources: sourceLabels(item["sources"], "unknown"),
			...lineRange(item),
			...(relevanceRank === undefined ? {} : { relevance_rank: relevanceRank }),
			...(tier === undefined ? {} : { ranking_tier: tier }),
			...(primaryScore === undefined ? {} : { ranking_score: primaryScore }),
			...(auxiliaryScore === undefined ? {} : { ranking_aux_score: auxiliaryScore }),
			...(selection === undefined ? {} : { selection }),
		});
	}
	return result;
}

function lineRange(value: Record<string, unknown>): Pick<Candidate, "start_line" | "end_line"> {
	const startLine = number(value["start_line"]);
	const endLine = number(value["end_line"]);
	return {
		...(startLine === undefined ? {} : { start_line: startLine }),
		...(endLine === undefined ? {} : { end_line: endLine }),
	};
}

function regionCount(value: unknown, queryMatch: "verified" | "semantic"): number | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item) => record(item)["query_match"] === queryMatch).length;
}

function arrayLength(value: unknown): number | undefined {
	return Array.isArray(value) ? value.length : undefined;
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function skippedCount(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	const skipped = record(value);
	let total = 0;
	for (const value of Object.values(skipped)) if (typeof value === "number" && Number.isFinite(value)) total += value;
	return total;
}
