import { fields } from "../../telemetry/projection.js";
import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { Candidate, Fields } from "../../telemetry/types.js";
import type { GrepParams, GrepRegionRanking, GrepSuccess } from "../grep/types.js";
import { isFailed, type ToolOutcome } from "../shared/result.js";
import { failureFields, failureScopeFields, projectFileInput } from "./common.js";

export const grepTelemetry = defineToolTelemetry<GrepParams, ToolOutcome<GrepSuccess>>({
	input: projectFileInput<GrepParams>(["query", "path", "glob"], "path", { pathList: true }),
	result(_params, details) {
		if (isFailed(details)) {
			return { fields: { ...failureFields(details), ...failureScopeFields(details) } };
		}
		return { fields: grepResultFields(details), candidates: grepCandidates(details) };
	},
});

function grepResultFields(details: GrepSuccess): Fields {
	const ranking = details.ranking;
	return fields({
		status: details.status,
		query_mode: details.query_mode,
		truncated: details.truncated_by.length > 0 ? true : undefined,
		truncation_reasons: details.truncated_by,
		total_candidate_count: details.total_candidates,
		returned_match_count: details.returned_regions,
		returned_file_count: details.returned_files,
		approx_token_count: details.approx_tokens,
		traversed_entry_count: details.stats.traversed_entries,
		searched_file_count: details.stats.searched_files,
		searched_byte_count: details.stats.searched_bytes,
		text_hit_count: details.stats.text_hits,
		parsed_file_count: details.stats.parsed_files,
		dropped_text_hit_count: details.stats.dropped_text_hits,
		dropped_related_anchor_count: details.stats.dropped_related_anchors,
		dropped_related_result_count: details.stats.dropped_related_results,
		ast_skipped_oversized_file_count: details.stats.ast_skipped_oversized_files,
		returned_verified_candidate_count: details.regions.filter((region) => region.query_match === "verified").length,
		returned_related_candidate_count: details.regions.filter((region) => region.query_match === "semantic").length,
		skipped_file_count: skippedCount(details.stats.skipped_files),
		scope_count: (details.paths?.length ?? 1) + (details.scope_errors?.length ?? 0),
		scope_error_count: details.scope_errors?.length ?? 0,
		ranking_algorithm: ranking?.algorithm,
		ranking_candidate_count: ranking?.candidate_count,
		ranking_eligible_candidate_count: ranking?.eligible_candidate_count,
		ranking_selected_candidate_count: ranking?.selected_candidate_count,
		ranking_head_size: ranking?.relevance_head_size,
		ranking_tier_count: ranking?.tier_count,
		ranking_top_tier_candidate_count: ranking?.top_tier_candidate_count,
		ranking_mmr_selected_count: ranking?.mmr_selected_count,
		ranking_mmr_replacement_count: ranking?.mmr_replacement_count,
		ranking_relevance_prefix_file_count: ranking?.relevance_prefix_file_count,
		ranking_selected_file_count: ranking?.selected_file_count,
	});
}

function grepCandidates(details: GrepSuccess): Candidate[] {
	return details.regions.map((region, index) => {
		const ranking = rankingRegion(details, index);
		return {
			kind: "region",
			value: region.path,
			rank: index + 1,
			group: region.query_match === "semantic" ? "related" : "verified",
			sources: [...new Set(region.sources)].sort(),
			start_line: region.start_line,
			end_line: region.end_line,
			...(ranking === undefined ? {} : {
				relevance_rank: ranking.relevance_rank,
				ranking_tier: ranking.tier,
				ranking_score: ranking.primary_score,
				ranking_aux_score: ranking.auxiliary_score,
				selection: ranking.selection,
			}),
		};
	});
}

function rankingRegion(details: GrepSuccess, index: number): GrepRegionRanking | undefined {
	if (details.ranking === undefined) return undefined;
	const region = details.ranking.regions[index];
	if (region === undefined) throw new Error("Grep ranking does not match displayed regions");
	return region;
}

function skippedCount(skipped: GrepSuccess["stats"]["skipped_files"]): number | undefined {
	if (skipped === undefined) return undefined;
	let total = 0;
	for (const value of Object.values(skipped)) {
		if (value !== undefined) total += value;
	}
	return total;
}
