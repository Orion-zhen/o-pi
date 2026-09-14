import type { RunRecord } from "../telemetry/types.js";

export interface TelemetryReportQuery {
	tools?: string[];
	git_commits?: string[];
	git_dirty?: boolean[];
	from?: string;
	to?: string;
}

export interface NumericSummary {
	samples: number;
	min?: number;
	max?: number;
	mean?: number;
	p50?: number;
	p95?: number;
}

export interface RateSummary {
	numerator: number;
	samples: number;
	value?: number;
}

export interface ToolStatistics {
	tool: string;
	calls: number;
	success_rate: RateSummary;
	error_rate: RateSummary;
	duration_ms: NumericSummary;
	output_chars: NumericSummary;
	truncation_rate: RateSummary;
	error_codes: Record<string, number>;
	input_path_count: NumericSummary;
	scope_count: NumericSummary;
	multi_scope_calls: number;
	scope_error_calls: number;
	scope_errors: number;
	repair: {
		observed_calls: number;
		repaired_rate: RateSummary;
		operations: Record<string, number>;
		fanout_calls: number;
		fanout_scopes: NumericSummary;
		fanout_separators: Record<string, number>;
	};
}

export interface EditBatchStatistics {
	batches: number;
	multi_file_batches: number;
	partial_failure_batches: number;
	calls_per_batch: NumericSummary;
	files_per_batch: NumericSummary;
	potential_call_reduction: number;
}

export interface EditReport {
	calls: number;
	successful_calls: number;
	failed_calls: number;
	no_change_calls: number;
	edits_per_call: NumericSummary;
	batches: EditBatchStatistics;
}

export interface ConversionAtK {
	k: number;
	lists: number;
	converted_lists: number;
	rate: number;
}

export interface RetentionAtK {
	k: number;
	adopted_events: number;
	retained_events: number;
	rate: number;
}

export interface NdcgAtK {
	k: number;
	lists: number;
	value: number;
}

export interface AdoptionWindowStatistics {
	lists: number;
	adopted_lists: number;
	adoption_rate: number;
	unknown_lists: number;
	hit_at_k: ConversionAtK[];
	mrr: { samples: number; value: number };
	ndcg_at_k: NdcgAtK[];
	retention_at_k: RetentionAtK[];
}

export interface CandidateActionStatistics {
	inspection: number;
	mutation: number;
	productive: number;
	inspection_only: number;
}

export interface CandidateNoveltyStatistics {
	novel_exposures: number;
	novel_exposure_rate: number;
	novel_immediate_adopted: number;
	novel_immediate_adoption_rate: number;
	novel_productive: number;
	novel_productive_adoption_rate: number;
	prior_known_exposures: number;
	prior_known_rate: number;
}

export interface CandidateLevelStatistics {
	producer_calls: number;
	exposures: number;
	immediate: AdoptionWindowStatistics;
	pre_refinement: AdoptionWindowStatistics;
	broad: AdoptionWindowStatistics;
	productive: AdoptionWindowStatistics;
	actions: CandidateActionStatistics;
	novelty: CandidateNoveltyStatistics;
	search_abandonment: number;
	search_abandonment_rate: number;
}

export interface SourceContributionStatistics {
	participation_exposures: number;
	participation_productive: number;
	participation_productive_rate: number;
	exclusive_exposures: number;
	exclusive_productive: number;
	exclusive_productive_rate: number;
	redundant_exposures: number;
	redundancy_rate: number;
}

export interface OutputEfficiencyStatistics {
	producer_calls: number;
	output_chars: number;
	immediate_adopted_lists: number;
	productive_adopted_lists: number;
	immediate_adopted_lists_per_1000_chars: number;
	productive_adopted_lists_per_1000_chars: number;
	chars_per_productive_adopted_list?: number;
	no_action_output_chars: number;
	no_action_output_share: number;
}

export interface CandidateRankingStatistics {
	producer_calls: number;
	candidates: number;
	file_level: CandidateLevelStatistics;
	region_level: CandidateLevelStatistics;
	by_source: Record<string, SourceContributionStatistics>;
	by_source_family: Record<string, SourceContributionStatistics>;
	output_efficiency: OutputEfficiencyStatistics;
}

export interface CandidateRankingReport extends CandidateRankingStatistics {
	heuristic: true;
	method: string;
	participation_note: string;
	by_tool: Record<string, CandidateRankingStatistics>;
}

export interface SearchCandidateUse {
	candidates: number;
	converted_candidates: number;
	candidate_conversion_rate: number;
	downstream_inspections: number;
	downstream_mutations: number;
	downstream_other: number;
}

export interface SearchEffectivenessStatistics extends SearchCandidateUse {
	calls: number;
	calls_with_candidates: number;
	calls_with_converted_candidates: number;
	zero_candidate_calls: number;
	calls_with_scanned_file_count: number;
	scanned_files: number;
}

export interface SearchEffectivenessReport extends SearchEffectivenessStatistics {
	heuristic: true;
	method: string;
	by_tool: Record<string, SearchEffectivenessStatistics>;
	by_group: Record<string, SearchCandidateUse>;
}

export interface GrepCandidateChannelStatistics {
	calls: number;
	candidates: number;
	immediate_adoption: RateSummary;
	pre_refinement_adoption: RateSummary;
	productive_adoption: RateSummary;
	downstream_inspections: number;
	downstream_mutations: number;
}

export interface GrepSourceStatistics {
	candidates: number;
	immediate_adoption: RateSummary;
	pre_refinement_adoption: RateSummary;
	productive_adoption: RateSummary;
}

export interface GrepPressureStatistics {
	total: number;
	calls: RateSummary;
}

export interface GrepRankingBucketStatistics {
	candidates: number;
	immediate_adoption: RateSummary;
	pre_refinement_adoption: RateSummary;
	productive_adoption: RateSummary;
	relevance_rank: NumericSummary;
	rank_promotion: NumericSummary;
	productive_rank_promotion: NumericSummary;
	primary_score: NumericSummary;
	productive_primary_score: NumericSummary;
	auxiliary_score: NumericSummary;
	productive_auxiliary_score: NumericSummary;
}

export interface GrepRankingAlgorithmStatistics {
	calls: number;
	candidate_pool: NumericSummary;
	eligible_candidates: NumericSummary;
	selected_candidates: NumericSummary;
	relevance_head: NumericSummary;
	tiers: NumericSummary;
	top_tier_candidates: NumericSummary;
	mmr_selected: NumericSummary;
	mmr_replacements: NumericSummary;
	selection_changed: RateSummary;
	relevance_prefix_files: NumericSummary;
	selected_files: NumericSummary;
	file_diversity_gain: NumericSummary;
	immediate: AdoptionWindowStatistics;
	pre_refinement: AdoptionWindowStatistics;
	productive: AdoptionWindowStatistics;
	by_tier: Record<string, GrepRankingBucketStatistics>;
	by_selection: Record<string, GrepRankingBucketStatistics>;
}

export interface GrepRankingReport {
	observed_calls: number;
	unobserved_calls: number;
	by_algorithm: Record<string, GrepRankingAlgorithmStatistics>;
}

export type GrepFindingCode =
	| "no_samples"
	| "incomplete_pipeline_facts"
	| "incomplete_ranking_facts"
	| "related_fallback_recovery"
	| "related_fallback_follow_up"
	| "frequent_empty_results"
	| "result_limit_pressure"
	| "related_limit_pressure"
	| "ast_size_limit_pressure"
	| "lsp_assistance_observed";

export interface GrepFinding {
	code: GrepFindingCode;
	severity: "info" | "warning";
	summary: string;
	evidence: RateSummary;
	total?: number;
}

export interface GrepReport {
	heuristic: true;
	method: string;
	calls: number;
	successful_calls: number;
	failed_calls: number;
	execution_path_observed_calls: number;
	direct_match: RateSummary;
	related_fallback: RateSummary;
	empty_result: RateSummary;
	related_recovery: RateSummary;
	work: {
		searched_files: NumericSummary;
		searched_bytes: NumericSummary;
		text_hits: NumericSummary;
		parsed_files: NumericSummary;
		ast_augmented_calls: RateSummary;
		returned_regions: NumericSummary;
		returned_files: NumericSummary;
		approx_tokens: NumericSummary;
	};
	limits: {
		result: RateSummary;
		depth: RateSummary;
		entries: RateSummary;
		bytes: RateSummary;
	};
	capacity: {
		dropped_text_hits: GrepPressureStatistics;
		dropped_related_anchors: GrepPressureStatistics;
		dropped_related_results: GrepPressureStatistics;
		ast_skipped_oversized_files: GrepPressureStatistics;
	};
	ranking: GrepRankingReport;
	by_result_kind: {
		verified: GrepCandidateChannelStatistics;
		related: GrepCandidateChannelStatistics;
	};
	by_source: Record<string, GrepSourceStatistics>;
	findings: GrepFinding[];
}

export interface TelemetryReport {
	metadata: {
		generated_at: string;
		input_files: string[];
		parsed_records: number;
		invalid_lines: number;
	};
	query: TelemetryReportQuery;
	inventory: {
		runs: number;
		sessions: number;
		calls: number;
		tools: number;
	};
	runs: RunRecord[];
	tools: ToolStatistics[];
	edit: EditReport;
	grep: GrepReport;
	search_effectiveness: SearchEffectivenessReport;
	candidate_ranking: CandidateRankingReport;
}
