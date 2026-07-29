import type { CallRecord, Candidate } from "../../telemetry/types.js";
import { frequency, ratio } from "../shared.js";
import type {
	AdoptionWindowStatistics,
	CandidateLevelStatistics,
	CandidateRankingCoreStatistics,
	CandidateRankingReport,
	CandidateRankingStatistics,
	ConversionAtK,
	OutputEfficiencyStatistics,
	SourceContributionStatistics,
} from "../types.js";
import {
	collectCandidateObservations,
	type CandidateAttribution,
	type CandidateLevel,
	type CandidateObservation,
	type CandidateObservationSet,
	type NormalizedCandidate,
	type ProducerObservation,
} from "./candidate-observations.js";

const K_VALUES = [1, 3, 5, 10] as const;

export function analyzeCandidateRanking(
	calls: readonly CallRecord[],
	cwdByRun: ReadonlyMap<string, string> = new Map(),
): CandidateRankingReport {
	return summarizeCandidateRanking(collectCandidateObservations(calls, cwdByRun));
}

export function summarizeCandidateRanking(observed: CandidateObservationSet): CandidateRankingReport {
	const tools = [...new Set(observed.producers.map((call) => call.tool))].sort();
	return {
		heuristic: true,
		method: "successful read/edit/write/webfetch consumers are uniquely attributed by range overlap, file match, producer recency, rank, and range specificity; broad retains the 10-call/5-minute window; candidate_conversion_rate is the legacy broad candidate-fact rate",
		participation_note: "source participation overlaps and must not be added; exclusive productive adoption is a lower bound and participation is an upper bound",
		...statistics(observed),
		by_tool: Object.fromEntries(tools.map((tool) => [tool, statistics(filterObserved(observed, tool))])),
	};
}

function statistics(observed: CandidateObservationSet): CandidateRankingStatistics {
	const fileLevel = levelStatistics(observed, "file");
	return {
		...coreStatistics(observed.producers, observed.observations),
		file_level: fileLevel,
		region_level: levelStatistics(observed, "region"),
		by_source: statisticsBySource(observed, exactSources),
		by_source_family: statisticsBySource(observed, sourceFamilies),
		output_efficiency: outputEfficiency(observed, fileLevel),
	};
}

function coreStatistics(
	producers: readonly CallRecord[],
	observations: readonly CandidateObservation[],
): CandidateRankingCoreStatistics {
	const converted = observations.filter((item) => item.consumer !== undefined);
	const events = converted.map((item) => ({ producer: item.producer, candidate: item.candidate }));
	const window = rankingWindow(producers, events, new Set());
	return {
		producer_calls: producers.length,
		candidates: observations.length,
		converted_candidates: converted.length,
		candidate_conversion_rate: ratio(converted.length, observations.length),
		conversion_at_k: window.hit_at_k,
		mrr: window.mrr,
		downstream_consumers: frequency(converted.flatMap((item) => item.consumer?.tool ?? [])),
	};
}

function levelStatistics(observed: CandidateObservationSet, level: CandidateLevel): CandidateLevelStatistics {
	const producerItems = observed.producer_observations.filter((item) => candidatesFor(item, level).length > 0);
	const producers = producerItems.map((item) => item.producer);
	const candidateObservations = level === "file" ? observed.observations : observed.region_observations;
	const attributions = observed.attributions.filter((item) => level === "file" || item.region_candidate !== undefined);
	const immediateEvents = adoptionEvents(attributions.filter((item) => item.immediate), level);
	const preEvents = adoptionEvents(attributions.filter((item) => item.pre_refinement), level);
	const broadAttributions = attributions.filter((item) => item.broad);
	const broadEvents = adoptionEvents(broadAttributions, level);
	const productiveAttributions = attributions.filter((item) => item.productive && level === "file");
	const productiveEvents = adoptionEvents(productiveAttributions, level);
	const unknown = (window: "immediate" | "pre_refinement" | "broad") => new Set(observed.attributions
		.filter((item) => item.region_unknown && item[window])
		.map((item) => callKey(item.producer)));
	const candidateActions = new Map<string, { inspection: boolean; mutation: boolean; productive: boolean }>();
	for (const item of attributions) {
		const candidate = candidateFor(item, level);
		if (candidate === undefined) continue;
		const key = `${callKey(item.producer)}\0${candidate.fact_key}`;
		const current = candidateActions.get(key) ?? { inspection: false, mutation: false, productive: false };
		current.inspection ||= item.inspection;
		current.mutation ||= item.mutation && level === "file";
		current.productive ||= item.productive && level === "file";
		candidateActions.set(key, current);
	}
	const novel = candidateObservations.filter((item) => item.candidate.novel);
	const immediateKeys = eventKeys(immediateEvents);
	const productiveKeys = eventKeys(productiveEvents);
	const abandoned = producerItems.filter((producer) => producer.next_search_index !== undefined
		&& !preEvents.some((event) => event.producer === producer.producer)).length;
	return {
		producer_calls: producers.length,
		exposures: candidateObservations.length,
		immediate: rankingWindow(producers, immediateEvents, level === "region" ? unknown("immediate") : new Set()),
		pre_refinement: rankingWindow(producers, preEvents, level === "region" ? unknown("pre_refinement") : new Set()),
		broad: rankingWindow(producers, broadEvents, level === "region" ? unknown("broad") : new Set()),
		productive: rankingWindow(producers, productiveEvents, new Set()),
		actions: {
			inspection: [...candidateActions.values()].filter((item) => item.inspection).length,
			mutation: [...candidateActions.values()].filter((item) => item.mutation).length,
			productive: [...candidateActions.values()].filter((item) => item.productive).length,
			inspection_only: [...candidateActions.values()].filter((item) => item.inspection && !item.productive).length,
		},
		novelty: {
			novel_exposures: novel.length,
			novel_exposure_rate: ratio(novel.length, candidateObservations.length),
			novel_immediate_adopted: novel.filter((item) => immediateKeys.has(observationKey(item))).length,
			novel_immediate_adoption_rate: ratio(novel.filter((item) => immediateKeys.has(observationKey(item))).length, novel.length),
			novel_productive: novel.filter((item) => productiveKeys.has(observationKey(item))).length,
			novel_productive_adoption_rate: ratio(novel.filter((item) => productiveKeys.has(observationKey(item))).length, novel.length),
			prior_known_exposures: candidateObservations.length - novel.length,
			prior_known_rate: ratio(candidateObservations.length - novel.length, candidateObservations.length),
		},
		search_abandonment: abandoned,
		search_abandonment_rate: ratio(abandoned, producerItems.filter((item) => item.next_search_index !== undefined).length),
	};
}

interface AdoptionEvent {
	producer: CallRecord;
	candidate: NormalizedCandidate;
}

function rankingWindow(
	producers: readonly CallRecord[],
	events: readonly AdoptionEvent[],
	unknownLists: ReadonlySet<string>,
): AdoptionWindowStatistics {
	const producerKeys = new Set(producers.map(callKey));
	const relevant = events.filter((event) => producerKeys.has(callKey(event.producer)));
	const adoptedProducerKeys = new Set(relevant.map((event) => callKey(event.producer)));
	const reciprocalRanks = producers.map((producer) => {
		const ranks = relevant.filter((event) => event.producer === producer).map((event) => event.candidate.rank);
		return ranks.length === 0 ? 0 : 1 / Math.min(...ranks);
	});
	return {
		lists: producers.length,
		adopted_lists: adoptedProducerKeys.size,
		adoption_rate: ratio(adoptedProducerKeys.size, producers.length),
		unknown_lists: [...unknownLists].filter((key) => producerKeys.has(key)).length,
		hit_at_k: K_VALUES.map((k) => hitAtK(k, producers, relevant)),
		mrr: {
			samples: reciprocalRanks.length,
			value: ratio(reciprocalRanks.reduce((sum, value) => sum + value, 0), reciprocalRanks.length),
		},
		retention_at_k: K_VALUES.map((k) => {
			const retained = relevant.filter((event) => event.candidate.rank <= k).length;
			return { k, adopted_events: relevant.length, retained_events: retained, rate: ratio(retained, relevant.length) };
		}),
	};
}

function hitAtK(k: number, producers: readonly CallRecord[], events: readonly AdoptionEvent[]): ConversionAtK {
	const converted = producers.filter((producer) => events.some((event) => event.producer === producer && event.candidate.rank <= k)).length;
	return { k, lists: producers.length, converted_lists: converted, rate: ratio(converted, producers.length) };
}

function statisticsBySource(
	observed: CandidateObservationSet,
	sourcesFor: (candidate: Candidate) => readonly string[],
): Record<string, SourceContributionStatistics> {
	const candidates = observed.observations;
	const productive = new Set(adoptionEvents(observed.attributions.filter((item) => item.productive), "file")
		.map((event) => `${callKey(event.producer)}\0${event.candidate.fact_key}`));
	const names = [...new Set(candidates.flatMap((item) => sourcesFor(item.candidate)))].sort();
	return Object.fromEntries(names.map((name) => {
		const participation = candidates.filter((item) => new Set(sourcesFor(item.candidate)).has(name));
		const exclusive = participation.filter((item) => new Set(sourcesFor(item.candidate)).size === 1);
		const participationProductive = participation.filter((item) => productive.has(observationKey(item))).length;
		const exclusiveProductive = exclusive.filter((item) => productive.has(observationKey(item))).length;
		const redundant = participation.length - exclusive.length;
		return [name, {
			participation_exposures: participation.length,
			participation_productive: participationProductive,
			participation_productive_rate: ratio(participationProductive, participation.length),
			exclusive_exposures: exclusive.length,
			exclusive_productive: exclusiveProductive,
			exclusive_productive_rate: ratio(exclusiveProductive, exclusive.length),
			redundant_exposures: redundant,
			redundancy_rate: ratio(redundant, participation.length),
		}];
	}));
}

function outputEfficiency(observed: CandidateObservationSet, fileLevel: CandidateLevelStatistics): OutputEfficiencyStatistics {
	const producerKeys = new Set(observed.producers.map(callKey));
	const preAdopted = new Set(observed.attributions.filter((item) => item.pre_refinement).map((item) => callKey(item.producer)));
	const productive = new Set(observed.attributions.filter((item) => item.productive).map((item) => callKey(item.producer)));
	const chars = observed.producers.reduce((sum, call) => sum + (call.output_chars ?? 0), 0);
	const noActionChars = observed.producers.filter((call) => !preAdopted.has(callKey(call))).reduce((sum, call) => sum + (call.output_chars ?? 0), 0);
	return {
		producer_calls: producerKeys.size,
		output_chars: chars,
		immediate_adopted_lists: fileLevel.immediate.adopted_lists,
		productive_adopted_lists: productive.size,
		immediate_adopted_lists_per_1000_chars: ratio(fileLevel.immediate.adopted_lists * 1000, chars),
		productive_adopted_lists_per_1000_chars: ratio(productive.size * 1000, chars),
		...(productive.size === 0 ? {} : { chars_per_productive_adopted_list: chars / productive.size }),
		no_action_output_chars: noActionChars,
		no_action_output_share: ratio(noActionChars, chars),
	};
}

function filterObserved(observed: CandidateObservationSet, tool: string): CandidateObservationSet {
	const producerObservations = observed.producer_observations.filter((item) => item.producer.tool === tool);
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

function adoptionEvents(attributions: readonly CandidateAttribution[], level: CandidateLevel): AdoptionEvent[] {
	return attributions.flatMap((item) => {
		const candidate = candidateFor(item, level);
		return candidate === undefined ? [] : [{ producer: item.producer, candidate }];
	});
}

function candidateFor(attribution: CandidateAttribution, level: CandidateLevel): NormalizedCandidate | undefined {
	return level === "file" ? attribution.file_candidate : attribution.region_candidate;
}

function candidatesFor(producer: ProducerObservation, level: CandidateLevel): readonly NormalizedCandidate[] {
	return level === "file" ? producer.file_candidates : producer.region_candidates;
}

function eventKeys(events: readonly AdoptionEvent[]): Set<string> {
	return new Set(events.map((event) => `${callKey(event.producer)}\0${event.candidate.fact_key}`));
}

function observationKey(observation: CandidateObservation): string {
	return `${callKey(observation.producer)}\0${observation.candidate.fact_key}`;
}

function callKey(call: CallRecord): string {
	return `${call.run_id}\0${call.call_id}`;
}

function exactSources(candidate: Candidate): readonly string[] {
	return candidate.sources.length === 0 ? ["unknown"] : [...new Set(candidate.sources)];
}

function sourceFamilies(candidate: Candidate): readonly string[] {
	return [...new Set(exactSources(candidate).map((source) => {
		if (source === "lsp" || source.startsWith("lsp-")) return "lsp";
		return source;
	}))];
}
