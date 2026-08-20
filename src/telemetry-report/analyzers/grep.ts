import type { CallRecord } from "../../telemetry/types.js";
import { compare, numericSummary, rateSummary } from "../shared.js";
import type {
	GrepCandidateChannelStatistics,
	GrepFinding,
	GrepPressureStatistics,
	GrepRankingAlgorithmStatistics,
	GrepRankingBucketStatistics,
	GrepRankingReport,
	GrepReport,
	GrepSourceStatistics,
	RateSummary,
} from "../types.js";
import { summarizeCandidateRanking } from "./candidate-ranking.js";
import {
	collectCandidateObservations,
	type CandidateAttribution,
	type CandidateObservation,
	type CandidateObservationSet,
} from "./candidate-observations.js";

type ResultKind = "verified" | "related";

export function analyzeGrep(
	calls: readonly CallRecord[],
	cwdByRun: ReadonlyMap<string, string> = new Map(),
): GrepReport {
	return summarizeGrep(calls, collectCandidateObservations(calls, cwdByRun));
}

export function summarizeGrep(calls: readonly CallRecord[], observed: CandidateObservationSet): GrepReport {
	const grepCalls = calls.filter((call) => call.tool === "grep");
	const successful = grepCalls.filter(isSuccessfulGrepCall);
	const pathObserved = successful.filter((call) => numericField(call, "text_hit_count") !== undefined);
	const direct = pathObserved.filter((call) => (numericField(call, "text_hit_count") ?? 0) > 0);
	const withoutDirect = pathObserved.filter((call) => numericField(call, "text_hit_count") === 0);
	const related = withoutDirect.filter((call) => (numericField(call, "returned_related_candidate_count") ?? 0) > 0);
	const empty = withoutDirect.filter((call) => (numericField(call, "returned_match_count") ?? call.candidates?.length ?? 0) === 0);
	const grepObserved = filterGrepObservations(observed);
	const capacity = {
		dropped_text_hits: pressure(successful, "dropped_text_hit_count"),
		dropped_related_anchors: pressure(successful, "dropped_related_anchor_count"),
		dropped_related_results: pressure(successful, "dropped_related_result_count"),
		ast_skipped_oversized_files: pressure(successful, "ast_skipped_oversized_file_count"),
	};
	const limits = {
		result: truncationRate(successful, "result_limit"),
		depth: truncationRate(successful, "depth_limit"),
		entries: truncationRate(successful, "entry_limit"),
		bytes: truncationRate(successful, "byte_limit"),
	};
	const byResultKind = {
		verified: channelStatistics(grepCalls, grepObserved, "verified"),
		related: channelStatistics(grepCalls, grepObserved, "related"),
	};
	const bySource = sourceStatistics(grepObserved.observations);
	const ranking = rankingStatistics(successful, grepObserved);
	const base = {
		heuristic: true as const,
		method: "text_hit_count separates direct matches from zero-hit related fallback; successful downstream read/edit/write calls use the shared unique-attribution windows",
		calls: grepCalls.length,
		successful_calls: successful.length,
		failed_calls: grepCalls.length - successful.length,
		execution_path_observed_calls: pathObserved.length,
		direct_match: rateSummary(direct.length, pathObserved.length),
		related_fallback: rateSummary(related.length, pathObserved.length),
		empty_result: rateSummary(empty.length, pathObserved.length),
		related_recovery: rateSummary(related.length, withoutDirect.length),
		work: {
			searched_files: numericFieldSummary(successful, "searched_file_count"),
			searched_bytes: numericFieldSummary(successful, "searched_byte_count"),
			text_hits: numericFieldSummary(successful, "text_hit_count"),
			parsed_files: numericFieldSummary(successful, "parsed_file_count"),
			ast_augmented_calls: observedPositiveRate(successful, "parsed_file_count"),
			returned_regions: numericFieldSummary(successful, "returned_match_count"),
			returned_files: numericFieldSummary(successful, "returned_file_count"),
			approx_tokens: numericFieldSummary(successful, "approx_token_count"),
		},
		limits,
		capacity,
		ranking,
		by_result_kind: byResultKind,
		by_source: bySource,
	};
	return {
		...base,
		findings: grepFindings(base),
	};
}

function filterGrepObservations(observed: CandidateObservationSet): CandidateObservationSet {
	const producerObservations = observed.producer_observations.filter((item) => item.producer.tool === "grep");
	const producers = producerObservations.map((item) => item.producer);
	const producerSet = new Set(producers);
	return {
		producers,
		producer_observations: producerObservations,
		attributions: observed.attributions.filter((item) => producerSet.has(item.producer)),
		observations: observed.observations.filter((item) => producerSet.has(item.producer)),
		region_observations: observed.region_observations.filter((item) => producerSet.has(item.producer)),
	};
}

function channelStatistics(
	calls: readonly CallRecord[],
	observed: CandidateObservationSet,
	kind: ResultKind,
): GrepCandidateChannelStatistics {
	const channelCalls = calls.filter((call) => call.candidates?.some((candidate) => candidate.group === kind));
	const callKeys = new Set(channelCalls.map(callKey));
	const attributions = observed.attributions.filter((item) =>
		callKeys.has(callKey(item.producer)) && item.file_candidate.group === kind);
	return {
		calls: channelCalls.length,
		candidates: channelCalls.reduce(
			(sum, call) => sum + (call.candidates?.filter((candidate) => candidate.group === kind).length ?? 0),
			0,
		),
		immediate_adoption: attributedCallRate(channelCalls, attributions, (item) => item.immediate),
		pre_refinement_adoption: attributedCallRate(channelCalls, attributions, (item) => item.pre_refinement),
		productive_adoption: attributedCallRate(channelCalls, attributions, (item) => item.productive),
		downstream_inspections: attributions.filter((item) => item.inspection).length,
		downstream_mutations: attributions.filter((item) => item.mutation).length,
	};
}

function attributedCallRate(
	calls: readonly CallRecord[],
	attributions: readonly CandidateAttribution[],
	matches: (item: CandidateAttribution) => boolean,
): RateSummary {
	const adopted = new Set(attributions.filter(matches).map((item) => callKey(item.producer)));
	return rateSummary(adopted.size, calls.length);
}

function sourceStatistics(observations: readonly CandidateObservation[]): Record<string, GrepSourceStatistics> {
	const sources = [...new Set(observations.flatMap((item) => item.candidate.sources))].sort(compare);
	return Object.fromEntries(sources.map((source) => {
		const participation = observations.filter((item) => item.candidate.sources.includes(source));
		return [source, {
			candidates: participation.length,
			immediate_adoption: rateSummary(participation.filter((item) => item.immediate).length, participation.length),
			pre_refinement_adoption: rateSummary(participation.filter((item) => item.pre_refinement).length, participation.length),
			productive_adoption: rateSummary(participation.filter((item) => item.productive).length, participation.length),
		}];
	}));
}

function rankingStatistics(
	calls: readonly CallRecord[],
	observed: CandidateObservationSet,
): GrepRankingReport {
	const rankedCalls = calls.filter((call) => rankingAlgorithm(call) !== undefined);
	const algorithms = [...new Set(rankedCalls.flatMap((call) => rankingAlgorithm(call) ?? []))].sort(compare);
	return {
		observed_calls: rankedCalls.length,
		unobserved_calls: calls.length - rankedCalls.length,
		by_algorithm: Object.fromEntries(algorithms.map((algorithm) => {
			const algorithmCalls = rankedCalls.filter((call) => rankingAlgorithm(call) === algorithm);
			return [algorithm, rankingAlgorithmStatistics(algorithmCalls, observed)];
		})),
	};
}

function rankingAlgorithmStatistics(
	calls: readonly CallRecord[],
	observed: CandidateObservationSet,
): GrepRankingAlgorithmStatistics {
	const filtered = filterObservationsByCalls(observed, calls);
	const quality = summarizeCandidateRanking(filtered).file_level;
	const diversityGains = calls.flatMap((call) => {
		const selected = numericField(call, "ranking_selected_file_count");
		const baseline = numericField(call, "ranking_relevance_prefix_file_count");
		return selected === undefined || baseline === undefined ? [] : [selected - baseline];
	});
	const replacements = calls.flatMap((call) => numericField(call, "ranking_mmr_replacement_count") ?? []);
	return {
		calls: calls.length,
		candidate_pool: numericFieldSummary(calls, "ranking_candidate_count"),
		eligible_candidates: numericFieldSummary(calls, "ranking_eligible_candidate_count"),
		selected_candidates: numericFieldSummary(calls, "ranking_selected_candidate_count"),
		relevance_head: numericFieldSummary(calls, "ranking_head_size"),
		tiers: numericFieldSummary(calls, "ranking_tier_count"),
		top_tier_candidates: numericFieldSummary(calls, "ranking_top_tier_candidate_count"),
		mmr_selected: numericFieldSummary(calls, "ranking_mmr_selected_count"),
		mmr_replacements: numericSummary(replacements),
		selection_changed: rateSummary(replacements.filter((value) => value > 0).length, replacements.length),
		relevance_prefix_files: numericFieldSummary(calls, "ranking_relevance_prefix_file_count"),
		selected_files: numericFieldSummary(calls, "ranking_selected_file_count"),
		file_diversity_gain: numericSummary(diversityGains),
		immediate: quality.immediate,
		pre_refinement: quality.pre_refinement,
		productive: quality.productive,
		by_tier: rankingBuckets(filtered.observations, (item) =>
			item.candidate.ranking_tier === undefined ? undefined : String(item.candidate.ranking_tier)),
		by_selection: rankingBuckets(filtered.observations, (item) => item.candidate.selection),
	};
}

function rankingBuckets(
	observations: readonly CandidateObservation[],
	keyOf: (item: CandidateObservation) => string | undefined,
): Record<string, GrepRankingBucketStatistics> {
	const keys = [...new Set(observations.flatMap((item) => keyOf(item) ?? []))].sort(compare);
	return Object.fromEntries(keys.map((key) => {
		const candidates = observations.filter((item) => keyOf(item) === key);
		return [key, rankingBucket(candidates)];
	}));
}

function rankingBucket(candidates: readonly CandidateObservation[]): GrepRankingBucketStatistics {
	const immediate = candidates.filter((item) => item.immediate);
	const preRefinement = candidates.filter((item) => item.pre_refinement);
	const productive = candidates.filter((item) => item.productive);
	return {
		candidates: candidates.length,
		immediate_adoption: rateSummary(immediate.length, candidates.length),
		pre_refinement_adoption: rateSummary(preRefinement.length, candidates.length),
		productive_adoption: rateSummary(productive.length, candidates.length),
		relevance_rank: numericSummary(candidates.flatMap((item) => item.candidate.relevance_rank ?? [])),
		rank_promotion: rankPromotionSummary(candidates),
		productive_rank_promotion: rankPromotionSummary(productive),
		primary_score: candidateScoreSummary(candidates, "ranking_score"),
		productive_primary_score: candidateScoreSummary(productive, "ranking_score"),
		auxiliary_score: candidateScoreSummary(candidates, "ranking_aux_score"),
		productive_auxiliary_score: candidateScoreSummary(productive, "ranking_aux_score"),
	};
}

function rankPromotionSummary(observations: readonly CandidateObservation[]) {
	return numericSummary(observations.flatMap((item) => {
		const relevanceRank = item.candidate.relevance_rank;
		return relevanceRank === undefined ? [] : [relevanceRank - item.candidate.rank];
	}));
}

function candidateScoreSummary(
	observations: readonly CandidateObservation[],
	key: "ranking_score" | "ranking_aux_score",
) {
	return numericSummary(observations.flatMap((item) => item.candidate[key] ?? []));
}

function filterObservationsByCalls(
	observed: CandidateObservationSet,
	calls: readonly CallRecord[],
): CandidateObservationSet {
	const callKeys = new Set(calls.map(callKey));
	const producerObservations = observed.producer_observations.filter((item) =>
		callKeys.has(callKey(item.producer)));
	const producers = producerObservations.map((item) => item.producer);
	const producerSet = new Set(producers);
	return {
		producers,
		producer_observations: producerObservations,
		attributions: observed.attributions.filter((item) => producerSet.has(item.producer)),
		observations: observed.observations.filter((item) => producerSet.has(item.producer)),
		region_observations: observed.region_observations.filter((item) => producerSet.has(item.producer)),
	};
}

function rankingAlgorithm(call: CallRecord): string | undefined {
	const value = call.fields?.["ranking_algorithm"];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function grepFindings(report: Omit<GrepReport, "findings">): GrepFinding[] {
	if (report.calls === 0) {
		return [{
			code: "no_samples",
			severity: "info",
			summary: "没有 grep 调用，无法评价新版执行链。",
			evidence: rateSummary(0, 0),
		}];
	}
	const findings: GrepFinding[] = [];
	if (report.execution_path_observed_calls < report.successful_calls) {
		findings.push({
			code: "incomplete_pipeline_facts",
			severity: "warning",
			summary: `只有 ${report.execution_path_observed_calls}/${report.successful_calls} 次成功调用包含新版执行路径事实，结论可能混入旧遥测。`,
			evidence: rateSummary(report.execution_path_observed_calls, report.successful_calls),
		});
	}
	if (report.ranking.unobserved_calls > 0) {
		findings.push({
			code: "incomplete_ranking_facts",
			severity: "warning",
			summary: `只有 ${report.ranking.observed_calls}/${report.successful_calls} 次成功调用包含排序算法事实，算法对比不会纳入其余调用。`,
			evidence: rateSummary(report.ranking.observed_calls, report.successful_calls),
		});
	}
	if (report.related_recovery.samples > 0) {
		findings.push({
			code: "related_fallback_recovery",
			severity: report.related_recovery.numerator === 0 && report.related_recovery.samples >= 5 ? "warning" : "info",
			summary: `在 ${report.related_recovery.samples} 次无直接命中的调用中，related fallback 找回 ${report.related_recovery.numerator} 次结果。`,
			evidence: report.related_recovery,
		});
	}
	const relatedFollowUp = report.by_result_kind.related.pre_refinement_adoption;
	if (relatedFollowUp.samples > 0) {
		findings.push({
			code: "related_fallback_follow_up",
			severity: relatedFollowUp.numerator === 0 && relatedFollowUp.samples >= 5 ? "warning" : "info",
			summary: `related 结果在下一次搜索前被采用 ${relatedFollowUp.numerator}/${relatedFollowUp.samples} 次。`,
			evidence: relatedFollowUp,
		});
	}
	if (report.empty_result.samples >= 5 && (report.empty_result.value ?? 0) >= 0.25) {
		findings.push({
			code: "frequent_empty_results",
			severity: "warning",
			summary: `仍有 ${report.empty_result.numerator}/${report.empty_result.samples} 次 grep 没有返回任何结果。`,
			evidence: report.empty_result,
		});
	}
	if (report.limits.result.numerator > 0) {
		findings.push({
			code: "result_limit_pressure",
			severity: "warning",
			summary: `${report.limits.result.numerator}/${report.limits.result.samples} 次调用触发结果条数限制，低排名候选未返回给模型。`,
			evidence: report.limits.result,
		});
	}
	const relatedDrops = report.capacity.dropped_related_results;
	if (relatedDrops.total > 0) {
		findings.push({
			code: "related_limit_pressure",
			severity: "info",
			summary: `${relatedDrops.calls.numerator} 次调用被 related 条数配置静默过滤，共过滤 ${relatedDrops.total} 个候选。`,
			evidence: relatedDrops.calls,
			total: relatedDrops.total,
		});
	}
	const astSkips = report.capacity.ast_skipped_oversized_files;
	if (astSkips.total > 0) {
		findings.push({
			code: "ast_size_limit_pressure",
			severity: "info",
			summary: `${astSkips.calls.numerator} 次调用有文件因 AST 大小限制未解析，共 ${astSkips.total} 个文件。`,
			evidence: astSkips.calls,
			total: astSkips.total,
		});
	}
	const lsp = report.by_source["lsp-symbol"];
	if (lsp !== undefined) {
		findings.push({
			code: "lsp_assistance_observed",
			severity: "info",
			summary: `LSP 参与 ${lsp.candidates} 个模型可见文件候选，其中 ${lsp.pre_refinement_adoption.numerator} 个在下一次搜索前被采用。`,
			evidence: lsp.pre_refinement_adoption,
			total: lsp.candidates,
		});
	}
	return findings;
}

function pressure(calls: readonly CallRecord[], key: string): GrepPressureStatistics {
	const observed = calls.flatMap((call) => {
		const value = numericField(call, key);
		return value === undefined ? [] : [value];
	});
	return {
		total: observed.reduce((sum, value) => sum + value, 0),
		calls: rateSummary(observed.filter((value) => value > 0).length, observed.length),
	};
}

function truncationRate(calls: readonly CallRecord[], reason: string): RateSummary {
	const observed = calls.filter((call) => Array.isArray(call.fields?.["truncation_reasons"]));
	return rateSummary(
		observed.filter((call) => {
			const reasons = call.fields?.["truncation_reasons"];
			return Array.isArray(reasons) && reasons.includes(reason);
		}).length,
		observed.length,
	);
}

function observedPositiveRate(calls: readonly CallRecord[], key: string): RateSummary {
	const observed = calls.flatMap((call) => numericField(call, key) ?? []);
	return rateSummary(observed.filter((value) => value > 0).length, observed.length);
}

function numericFieldSummary(calls: readonly CallRecord[], key: string) {
	return numericSummary(calls.flatMap((call) => numericField(call, key) ?? []));
}

function numericField(call: CallRecord, key: string): number | undefined {
	const value = call.fields?.[key];
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isSuccessfulGrepCall(call: CallRecord): boolean {
	const status = call.fields?.["status"];
	if (typeof status === "string") return call.status === "success" && status === "success";
	return call.status === "success";
}

function callKey(call: CallRecord): string {
	return `${call.run_id}\0${call.call_id}`;
}
