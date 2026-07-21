import type { CallRecord } from "../../telemetry/types.js";
import { compare, ratio } from "../shared.js";
import type { SearchCandidateUse, SearchEffectivenessReport, SearchEffectivenessStatistics } from "../types.js";
import { collectCandidateObservations, type CandidateObservation, type CandidateObservationSet } from "./candidate-observations.js";

const SEARCH_TOOLS = new Set(["find", "grep", "websearch"]);

export function analyzeSearchEffectiveness(
	calls: readonly CallRecord[],
	cwdByRun: ReadonlyMap<string, string> = new Map(),
): SearchEffectivenessReport {
	return summarizeSearchEffectiveness(calls, collectCandidateObservations(calls, cwdByRun));
}

export function summarizeSearchEffectiveness(
	calls: readonly CallRecord[],
	observed: CandidateObservationSet,
): SearchEffectivenessReport {
	const searchCalls = calls.filter((call) => SEARCH_TOOLS.has(call.tool));
	const observations = observed.observations.filter((item) => SEARCH_TOOLS.has(item.producer.tool));
	const tools = [...new Set(searchCalls.map((call) => call.tool))].sort(compare);
	return {
		heuristic: true,
		method: "search candidates use the candidate-ranking target-match heuristic",
		...statistics(searchCalls, observations),
		by_tool: Object.fromEntries(tools.map((tool) => [
			tool,
			statistics(
				searchCalls.filter((call) => call.tool === tool),
				observations.filter((item) => item.producer.tool === tool),
			),
		])),
		by_group: statisticsByGroup(observations),
	};
}

function statistics(calls: readonly CallRecord[], observations: readonly CandidateObservation[]): SearchEffectivenessStatistics {
	const converted = observations.filter((item) => item.consumer !== undefined);
	const convertedProducers = new Set(converted.map((item) => callKey(item.producer)));
	const scannedFileCounts = calls.flatMap((call) => scannedFileCount(call.fields?.["scanned_file_count"]) ?? []);
	return {
		calls: calls.length,
		calls_with_candidates: calls.filter((call) => (call.candidates?.length ?? 0) > 0).length,
		calls_with_converted_candidates: calls.filter((call) => convertedProducers.has(callKey(call))).length,
		zero_candidate_calls: calls.filter((call) => (call.candidates?.length ?? 0) === 0).length,
		calls_with_scanned_file_count: scannedFileCounts.length,
		scanned_files: scannedFileCounts.reduce((sum, value) => sum + value, 0),
		...candidateUse(observations),
	};
}

function statisticsByGroup(observations: readonly CandidateObservation[]): Record<string, SearchCandidateUse> {
	const grouped = new Map<string, CandidateObservation[]>();
	for (const observation of observations) {
		const group = observation.candidate.group ?? "ungrouped";
		const values = grouped.get(group);
		if (values === undefined) grouped.set(group, [observation]);
		else values.push(observation);
	}
	return Object.fromEntries([...grouped].sort(([left], [right]) => compare(left, right)).map(([group, values]) => [
		group,
		candidateUse(values),
	]));
}

function candidateUse(observations: readonly CandidateObservation[]): SearchCandidateUse {
	const converted = observations.filter((item) => item.consumer !== undefined);
	const inspected = converted.filter((item) => item.consumer?.tool === "read" || item.consumer?.tool === "webfetch").length;
	const mutated = converted.filter((item) => item.consumer?.tool === "edit" || item.consumer?.tool === "write").length;
	return {
		candidates: observations.length,
		converted_candidates: converted.length,
		candidate_conversion_rate: ratio(converted.length, observations.length),
		downstream_inspections: inspected,
		downstream_mutations: mutated,
		downstream_other: converted.length - inspected - mutated,
	};
}

function callKey(call: CallRecord): string {
	return `${call.run_id}\0${call.call_id}`;
}

function scannedFileCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
