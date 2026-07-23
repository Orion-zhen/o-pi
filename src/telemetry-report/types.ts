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

export interface CandidateRankingCoreStatistics {
	producer_calls: number;
	candidates: number;
	converted_candidates: number;
	candidate_conversion_rate: number;
	conversion_at_k: ConversionAtK[];
	mrr: { samples: number; value: number };
	downstream_consumers: Record<string, number>;
}

export interface CandidateRankingStatistics extends CandidateRankingCoreStatistics {
	by_source: Record<string, CandidateRankingCoreStatistics>;
	by_source_family: Record<string, CandidateRankingCoreStatistics>;
}

export interface CandidateRankingReport extends CandidateRankingStatistics {
	heuristic: true;
	method: string;
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
	search_effectiveness: SearchEffectivenessReport;
	candidate_ranking: CandidateRankingReport;
}
