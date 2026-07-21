import type { CallRecord, Candidate } from "../../telemetry/types.js";
import { callsByRun, resourceMatches, sameBatch, withinMillis } from "../shared.js";

const CALL_WINDOW = 10;
const TIME_WINDOW_MS = 5 * 60_000;

export interface CandidateObservation {
	producer: CallRecord;
	candidate: Candidate;
	consumer?: CallRecord;
}

export interface CandidateObservationSet {
	producers: CallRecord[];
	observations: CandidateObservation[];
}

/** Resolve candidate use once so every candidate report shares one heuristic. */
export function collectCandidateObservations(
	calls: readonly CallRecord[],
	cwdByRun: ReadonlyMap<string, string> = new Map(),
): CandidateObservationSet {
	const producers: CallRecord[] = [];
	const observations: CandidateObservation[] = [];
	for (const chain of callsByRun(calls).values()) {
		for (const [index, producer] of chain.entries()) {
			if ((producer.candidates?.length ?? 0) === 0) continue;
			producers.push(producer);
			for (const candidate of producer.candidates ?? []) {
				observations.push({ producer, candidate, ...consumerFor(chain, index, candidate, cwdByRun) });
			}
		}
	}
	return { producers, observations };
}

function consumerFor(
	calls: readonly CallRecord[],
	producerIndex: number,
	candidate: Candidate,
	cwdByRun: ReadonlyMap<string, string>,
): { consumer?: CallRecord } {
	const producer = calls[producerIndex];
	if (producer === undefined) return {};
	const producerCwd = cwdByRun.get(producer.run_id) ?? ".";
	for (let offset = 1; offset <= CALL_WINDOW; offset += 1) {
		const consumer = calls[producerIndex + offset];
		if (consumer === undefined || !withinMillis(producer, consumer, TIME_WINDOW_MS)) break;
		if (sameBatch(producer, consumer)) continue;
		const consumerCwd = cwdByRun.get(consumer.run_id) ?? producerCwd;
		if ((consumer.targets ?? []).some((target) => resourceMatches(candidate, target, producerCwd, consumerCwd))) return { consumer };
	}
	return {};
}
