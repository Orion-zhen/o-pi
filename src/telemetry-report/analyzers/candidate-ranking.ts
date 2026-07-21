import type { CallRecord, Candidate } from "../../telemetry/types.js";
import { frequency, ratio } from "../shared.js";
import type {
	CandidateRankingCoreStatistics,
	CandidateRankingReport,
	CandidateRankingStatistics,
	ConversionAtK,
} from "../types.js";
import {
	collectCandidateObservations,
	type CandidateObservation,
	type CandidateObservationSet,
} from "./candidate-observations.js";

const K_VALUES = [1, 3, 5, 10] as const;

export function analyzeCandidateRanking(
	calls: readonly CallRecord[],
	cwdByRun: ReadonlyMap<string, string> = new Map(),
): CandidateRankingReport {
	return summarizeCandidateRanking(collectCandidateObservations(calls, cwdByRun));
}

export function summarizeCandidateRanking({ producers, observations }: CandidateObservationSet): CandidateRankingReport {
	const tools = [...new Set(producers.map((call) => call.tool))].sort();
	return {
		heuristic: true,
		method: "first later target match within 10 calls and 5 minutes; calls from the producer's parallel batch are excluded",
		...statistics(producers, observations),
		by_tool: Object.fromEntries(tools.map((tool) => [tool, statistics(
			producers.filter((call) => call.tool === tool),
			observations.filter((observation) => observation.producer.tool === tool),
		)])),
	};
}

function statistics(producers: readonly CallRecord[], observations: readonly CandidateObservation[]): CandidateRankingStatistics {
	return {
		...coreStatistics(producers, observations),
		by_source: statisticsBySource(observations, exactSources),
		by_source_family: statisticsBySource(observations, sourceFamilies),
	};
}

function coreStatistics(
	producers: readonly CallRecord[],
	observations: readonly CandidateObservation[],
): CandidateRankingCoreStatistics {
	const converted = observations.filter((observation) => observation.consumer !== undefined);
	const byCall = new Map<string, CandidateObservation[]>();
	for (const observation of observations) {
		const key = callKey(observation.producer);
		const values = byCall.get(key);
		if (values === undefined) byCall.set(key, [observation]);
		else values.push(observation);
	}
	const reciprocalRanks = producers.map((producer) => {
		const ranks = (byCall.get(callKey(producer)) ?? []).filter((item) => item.consumer !== undefined).map((item) => item.candidate.rank);
		return ranks.length === 0 ? 0 : 1 / Math.min(...ranks);
	});
	return {
		producer_calls: producers.length,
		candidates: observations.length,
		converted_candidates: converted.length,
		candidate_conversion_rate: ratio(converted.length, observations.length),
		conversion_at_k: K_VALUES.map((k) => conversionAtK(k, producers, byCall)),
		mrr: { samples: reciprocalRanks.length, value: ratio(reciprocalRanks.reduce((sum, value) => sum + value, 0), reciprocalRanks.length) },
		downstream_consumers: frequency(converted.flatMap((item) => item.consumer?.tool ?? [])),
	};
}

function conversionAtK(k: number, producers: readonly CallRecord[], observations: ReadonlyMap<string, readonly CandidateObservation[]>): ConversionAtK {
	const converted = producers.filter((producer) => (observations.get(callKey(producer)) ?? [])
		.some((item) => item.candidate.rank <= k && item.consumer !== undefined)).length;
	return { k, lists: producers.length, converted_lists: converted, rate: ratio(converted, producers.length) };
}

function callKey(call: CallRecord): string {
	return `${call.run_id}\0${call.call_id}`;
}

function statisticsBySource(
	observations: readonly CandidateObservation[],
	sourcesFor: (candidate: Candidate) => readonly string[],
): Record<string, CandidateRankingCoreStatistics> {
	const groups = new Map<string, CandidateObservation[]>();
	for (const observation of observations) {
		for (const source of new Set(sourcesFor(observation.candidate))) {
			const values = groups.get(source);
			if (values === undefined) groups.set(source, [observation]);
			else values.push(observation);
		}
	}
	return Object.fromEntries([...groups].sort(([left], [right]) => left.localeCompare(right, "en")).map(([source, values]) => [
		source,
		coreStatistics(uniqueProducers(values), values),
	]));
}

function uniqueProducers(observations: readonly CandidateObservation[]): CallRecord[] {
	return [...new Map(observations.map((observation) => [callKey(observation.producer), observation.producer])).values()];
}

function exactSources(candidate: Candidate): readonly string[] {
	return candidate.sources.length === 0 ? ["unknown"] : candidate.sources;
}

function sourceFamilies(candidate: Candidate): readonly string[] {
	return exactSources(candidate).flatMap((source) => {
		if (source === "repo-map" || source.startsWith("repo-map-")) return ["repo-map"];
		if (source === "lsp" || source.startsWith("lsp-")) return ["lsp"];
		return [];
	});
}
