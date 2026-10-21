import type { CallRecord, Candidate } from "../../telemetry/types.ts";
import { ratio } from "../shared.ts";
import type {
	AdoptionWindowStatistics,
	CandidateLevelStatistics,
	CandidateRankingReport,
	CandidateRankingStatistics,
	ConversionAtK,
	OutputEfficiencyStatistics,
	SourceContributionStatistics,
} from "../types.ts";
import {
	type CandidateAttribution,
	type CandidateLevel,
	type CandidateObservationSet,
	type NormalizedCandidate,
	type ProducerObservation,
} from "./candidate-observations.ts";

const K_VALUES = [1, 3, 5, 10] as const;

export function summarizeCandidateRanking(observed: CandidateObservationSet): CandidateRankingReport {
	const tools = [...new Set(observed.producers.map((call) => call.tool))].sort();
	return {
		heuristic: true,
		method: "successful read/edit/write/webfetch consumers are uniquely attributed by range overlap, file match, producer recency, rank, and range specificity; broad retains the 10-call/5-minute window",
		participation_note: "source participation overlaps and must not be added; exclusive productive adoption is a lower bound and participation is an upper bound",
		...statistics(observed),
		by_tool: Object.fromEntries(tools.map((tool) => [tool, statistics(filterObserved(observed, tool))])),
	};
}

function statistics(observed: CandidateObservationSet): CandidateRankingStatistics {
	const fileLevel = levelStatistics(observed, "file");
	return {
		producer_calls: observed.producers.length,
		candidates: observed.observations.length,
		file_level: fileLevel,
		region_level: levelStatistics(observed, "region"),
		by_source: statisticsBySource(observed, exactSources),
		by_source_family: statisticsBySource(observed, sourceFamilies),
		output_efficiency: outputEfficiency(observed, fileLevel),
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
		.map((item) => item.producer)).size;
	const novel = candidateObservations.filter((item) => item.candidate.novel);
	const novelImmediate = novel.filter((item) => item.immediate).length;
	const novelProductive = novel.filter((item) => item.productive).length;
	const preProducers = new Set(preEvents.map((event) => event.producer));
	const abandoned = producerItems.filter((producer) => producer.next_search_index !== undefined
		&& !preProducers.has(producer.producer)).length;
	return {
		producer_calls: producers.length,
		exposures: candidateObservations.length,
		immediate: rankingWindow(producers, immediateEvents, level === "region" ? unknown("immediate") : 0),
		pre_refinement: rankingWindow(producers, preEvents, level === "region" ? unknown("pre_refinement") : 0),
		broad: rankingWindow(producers, broadEvents, level === "region" ? unknown("broad") : 0),
		productive: rankingWindow(producers, productiveEvents),
		actions: {
			inspection: candidateObservations.filter((item) => item.inspection).length,
			mutation: candidateObservations.filter((item) => item.mutation).length,
			productive: candidateObservations.filter((item) => item.productive).length,
			inspection_only: candidateObservations.filter((item) => item.inspection && !item.productive).length,
		},
		novelty: {
			novel_exposures: novel.length,
			novel_exposure_rate: ratio(novel.length, candidateObservations.length),
			novel_immediate_adopted: novelImmediate,
			novel_immediate_adoption_rate: ratio(novelImmediate, novel.length),
			novel_productive: novelProductive,
			novel_productive_adoption_rate: ratio(novelProductive, novel.length),
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
	unknownLists = 0,
): AdoptionWindowStatistics {
	const grouped = new Map<CallRecord, Set<NormalizedCandidate>>();
	for (const event of events) {
		const candidates = grouped.get(event.producer) ?? new Set<NormalizedCandidate>();
		candidates.add(event.candidate);
		grouped.set(event.producer, candidates);
	}
	const ranks = producers.map((producer) => Array.from(grouped.get(producer) ?? [], (candidate) => candidate.rank));
	const reciprocalRanks = ranks.map((values) => 1 / values.reduce((minimum, rank) => Math.min(minimum, rank), Infinity));
	return {
		lists: producers.length,
		adopted_lists: grouped.size,
		adoption_rate: ratio(grouped.size, producers.length),
		unknown_lists: unknownLists,
		hit_at_k: K_VALUES.map((k) => hitAtK(k, ranks)),
		mrr: {
			samples: reciprocalRanks.length,
			value: ratio(reciprocalRanks.reduce((sum, value) => sum + value, 0), reciprocalRanks.length),
		},
		ndcg_at_k: K_VALUES.map((k) => ndcgAtK(k, ranks)),
		retention_at_k: K_VALUES.map((k) => {
			const retained = events.filter((event) => event.candidate.rank <= k).length;
			return { k, adopted_events: events.length, retained_events: retained, rate: ratio(retained, events.length) };
		}),
	};
}

function ndcgAtK(
	k: number,
	ranksByProducer: readonly (readonly number[])[],
): { k: number; lists: number; value: number } {
	const values = ranksByProducer.map((ranks) => {
		const dcg = ranks
			.filter((rank) => rank <= k)
			.reduce((sum, rank) => sum + discountedGain(rank), 0);
		const ideal = Array.from(
			{ length: Math.min(k, ranks.length) },
			(_value, index) => discountedGain(index + 1),
		).reduce((sum, value) => sum + value, 0);
		return ratio(dcg, ideal);
	});
	return {
		k,
		lists: ranksByProducer.length,
		value: ratio(values.reduce((sum, value) => sum + value, 0), values.length),
	};
}

function discountedGain(rank: number): number {
	return 1 / Math.log2(rank + 1);
}

function hitAtK(k: number, ranks: readonly (readonly number[])[]): ConversionAtK {
	const converted = ranks.filter((values) => values.some((rank) => rank <= k)).length;
	return { k, lists: ranks.length, converted_lists: converted, rate: ratio(converted, ranks.length) };
}

function statisticsBySource(
	observed: CandidateObservationSet,
	sourcesFor: (candidate: Candidate) => readonly string[],
): Record<string, SourceContributionStatistics> {
	const candidates = observed.observations;
	const names = [...new Set(candidates.flatMap((item) => sourcesFor(item.candidate)))].sort();
	return Object.fromEntries(names.map((name) => {
		const participation = candidates.filter((item) => new Set(sourcesFor(item.candidate)).has(name));
		const exclusive = participation.filter((item) => new Set(sourcesFor(item.candidate)).size === 1);
		const participationProductive = participation.filter((item) => item.productive).length;
		const exclusiveProductive = exclusive.filter((item) => item.productive).length;
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
