import type { CallRecord, Candidate, Resource } from "../../telemetry/types.ts";
import { callsByRun, requireRunCwd, resourceKey, sameBatch, withinMillis } from "../shared.ts";
import { markReadThenMutationProductive } from "./productive-attributions.ts";

const CALL_WINDOW = 10;
const TIME_WINDOW_MS = 5 * 60_000;
const SEARCH_TOOLS = new Set(["find", "grep", "websearch"]);
const CONSUMER_TOOLS = new Set(["read", "edit", "write", "webfetch"]);
const INSPECTION_TOOLS = new Set(["read", "webfetch"]);
const MUTATION_TOOLS = new Set(["edit", "write"]);
const PRIOR_ACCESS_TOOLS = new Set(["read", "edit", "write"]);

export type CandidateLevel = "file" | "region";

export interface NormalizedCandidate extends Candidate {
	file_key: string;
	fact_key: string;
	novel: boolean;
}

export interface CandidateAttribution {
	producer: CallRecord;
	candidate: NormalizedCandidate;
	file_candidate: NormalizedCandidate;
	consumer: CallRecord;
	target: Resource;
	immediate: boolean;
	pre_refinement: boolean;
	broad: boolean;
	inspection: boolean;
	mutation: boolean;
	productive: boolean;
	region_candidate?: NormalizedCandidate;
	region_unknown: boolean;
}

export interface ProducerObservation {
	producer: CallRecord;
	chain_index: number;
	fact_candidates: NormalizedCandidate[];
	file_candidates: NormalizedCandidate[];
	region_candidates: NormalizedCandidate[];
	next_search_index?: number;
	first_consumer_index?: number;
}

/** One normalized candidate with broad and current-window adoption facts. */
export interface CandidateObservation {
	producer: CallRecord;
	candidate: NormalizedCandidate;
	consumer?: CallRecord;
	immediate: boolean;
	pre_refinement: boolean;
	productive: boolean;
	inspection: boolean;
	mutation: boolean;
}

export interface CandidateObservationSet {
	producers: CallRecord[];
	producer_observations: ProducerObservation[];
	attributions: CandidateAttribution[];
	observations: CandidateObservation[];
	region_observations: CandidateObservation[];
}

/** Normalize candidate facts and attribute every successful downstream consumer at most once. */
export function collectCandidateObservations(
	calls: readonly CallRecord[],
	cwdByRun: ReadonlyMap<string, string>,
): CandidateObservationSet {
	const producerObservations: ProducerObservation[] = [];
	const attributions: CandidateAttribution[] = [];
	for (const [runId, chain] of callsByRun(calls)) {
		const cwd = requireRunCwd(cwdByRun, runId);
		const producers = buildProducers(chain, cwd);
		producerObservations.push(...producers);
		attributions.push(...attributeConsumers(chain, producers, cwd));
	}
	const producers = producerObservations.map((item) => item.producer);
	return {
		producers,
		producer_observations: producerObservations,
		attributions,
		observations: candidateObservations(producerObservations, attributions, "file"),
		region_observations: candidateObservations(producerObservations, attributions, "region"),
	};
}

function buildProducers(calls: readonly CallRecord[], cwd: string): ProducerObservation[] {
	const result: ProducerObservation[] = [];
	const priorFiles = new Set<string>();
	const searches = nextOutsideBatch(calls, (call) => SEARCH_TOOLS.has(call.tool));
	const consumers = nextOutsideBatch(calls, isConsumer);
	for (const [index, producer] of calls.entries()) {
		const candidates = producer.candidates;
		if (candidates !== undefined && candidates.length > 0) {
			const facts = normalizeCandidates(candidates, cwd, priorFiles, false);
			const files = normalizeCandidates(candidates, cwd, priorFiles, true);
			const next = searches[index];
			const first = consumers[index];
			result.push({
				producer, chain_index: index, fact_candidates: facts, file_candidates: files,
				region_candidates: facts.filter(hasRange),
				...(next === undefined ? {} : { next_search_index: next }),
				...(first === undefined ? {} : { first_consumer_index: first }),
			});
		}
		if (producer.status === "success" && PRIOR_ACCESS_TOOLS.has(producer.tool)) {
			for (const target of producer.targets ?? []) priorFiles.add(resourceKey(target, cwd));
		}
	}
	return result;
}

function normalizeCandidates(
	candidates: readonly Candidate[],
	cwd: string,
	priorFiles: ReadonlySet<string>,
	fileLevel: boolean,
): NormalizedCandidate[] {
	const merged = new Map<string, NormalizedCandidate>();
	for (const candidate of candidates) {
		const fileKey = resourceKey(candidate, cwd);
		const factKey = fileLevel ? fileKey : `${fileKey}\0${candidate.start_line ?? ""}\0${candidate.end_line ?? ""}`;
		const existing = merged.get(factKey);
		if (existing === undefined) {
			const normalized = fileLevel
				? {
					kind: candidate.kind === "url" ? "url" : "file",
					value: candidate.value,
					rank: candidate.rank,
					...(candidate.group === undefined ? {} : { group: candidate.group }),
					sources: candidate.sources,
					...rankingFacts(candidate),
				}
				: candidate;
			merged.set(factKey, {
				...normalized,
				sources: [...new Set(candidate.sources)].sort(),
				file_key: fileKey,
				fact_key: factKey,
				novel: !priorFiles.has(fileKey),
			});
			continue;
		}
		existing.sources = [...new Set([...existing.sources, ...candidate.sources])].sort();
		if (candidate.rank < existing.rank) {
			existing.rank = candidate.rank;
			if (candidate.group === undefined) delete existing.group;
			else existing.group = candidate.group;
			replaceRankingFacts(existing, candidate);
		}
	}
	return [...merged.values()].sort((left, right) => left.rank - right.rank || left.fact_key.localeCompare(right.fact_key, "en"));
}

function rankingFacts(candidate: Candidate): Pick<Candidate,
	"relevance_rank" | "ranking_tier" | "ranking_score" | "ranking_aux_score" | "selection"> {
	return {
		...(candidate.relevance_rank === undefined ? {} : { relevance_rank: candidate.relevance_rank }),
		...(candidate.ranking_tier === undefined ? {} : { ranking_tier: candidate.ranking_tier }),
		...(candidate.ranking_score === undefined ? {} : { ranking_score: candidate.ranking_score }),
		...(candidate.ranking_aux_score === undefined ? {} : { ranking_aux_score: candidate.ranking_aux_score }),
		...(candidate.selection === undefined ? {} : { selection: candidate.selection }),
	};
}

function replaceRankingFacts(target: Candidate, source: Candidate): void {
	for (const key of ["relevance_rank", "ranking_tier", "ranking_score", "ranking_aux_score", "selection"] as const) {
		const value = source[key];
		if (value === undefined) delete target[key];
		else Object.assign(target, { [key]: value });
	}
}

function attributeConsumers(
	calls: readonly CallRecord[],
	producers: readonly ProducerObservation[],
	cwd: string,
): CandidateAttribution[] {
	const result: CandidateAttribution[] = [];
	type Exposure = { producer: ProducerObservation; candidate: NormalizedCandidate };
	const byFile = new Map<string, Set<Exposure>>();
	const expires = new Map<number, Exposure[]>();
	const starts = new Map<number, Exposure[]>();
	for (const producer of producers) {
		const items = producer.fact_candidates.map((candidate) => ({ producer, candidate }));
		starts.set(producer.chain_index + 1, items);
		const end = Math.max(producer.next_search_index ?? calls.length,
			(producer.first_consumer_index ?? -1) + 1, producer.chain_index + CALL_WINDOW + 1);
		const bucket = expires.get(end) ?? [];
		bucket.push(...items);
		expires.set(end, bucket);
	}
	for (const [consumerIndex, consumer] of calls.entries()) {
		for (const item of expires.get(consumerIndex) ?? []) {
			const bucket = byFile.get(item.candidate.file_key);
			bucket?.delete(item);
			if (bucket?.size === 0) byFile.delete(item.candidate.file_key);
		}
		for (const item of starts.get(consumerIndex) ?? []) {
			const bucket = byFile.get(item.candidate.file_key) ?? new Set<Exposure>();
			bucket.add(item);
			byFile.set(item.candidate.file_key, bucket);
		}
		if (!isConsumer(consumer)) continue;
		let selected: AttributionMatch | undefined;
		for (const target of consumer.targets) {
			for (const { producer, candidate } of byFile.get(resourceKey(target, cwd)) ?? []) {
				if (sameBatch(producer.producer, consumer)) continue;
				const windows = windowsFor(producer, producer.chain_index, consumer, consumerIndex);
				if (!windows.immediate && !windows.pre_refinement && !windows.broad) continue;
				const match = { producer, candidate, target, windows, intersects: rangesIntersect(candidate, target) };
				if (selected === undefined || (compareMatches(match, selected)
					|| producer.chain_index - selected.producer.chain_index) < 0) selected = match;
			}
		}
		if (selected === undefined) continue;
		const fileCandidate = requireFileCandidate(selected.producer, selected.candidate.file_key);
		const regionCandidate = selected.intersects && hasRange(selected.target) && hasRange(selected.candidate)
			? selected.candidate
			: undefined;
		result.push({
			producer: selected.producer.producer,
			candidate: selected.candidate,
			file_candidate: fileCandidate,
			consumer,
			target: selected.target,
			...selected.windows,
			inspection: INSPECTION_TOOLS.has(consumer.tool),
			mutation: MUTATION_TOOLS.has(consumer.tool),
			productive: MUTATION_TOOLS.has(consumer.tool),
			...(regionCandidate === undefined ? {} : { region_candidate: regionCandidate }),
			region_unknown: !hasRange(selected.target)
				&& selected.producer.region_candidates.some((item) => item.file_key === selected.candidate.file_key),
		});
	}
	markReadThenMutationProductive(calls, result, cwd);
	return result;
}

interface AttributionMatch {
	producer: ProducerObservation;
	candidate: NormalizedCandidate;
	target: Resource;
	windows: Pick<CandidateAttribution, "immediate" | "pre_refinement" | "broad">;
	intersects: boolean;
}

function compareMatches(left: AttributionMatch, right: AttributionMatch): number {
	return Number(right.intersects) - Number(left.intersects)
		|| right.producer.producer.call_index - left.producer.producer.call_index
		|| left.candidate.rank - right.candidate.rank
		|| rangeSize(left.candidate) - rangeSize(right.candidate)
		|| left.candidate.fact_key.localeCompare(right.candidate.fact_key, "en");
}

function windowsFor(
	producer: ProducerObservation,
	producerIndex: number,
	consumer: CallRecord,
	consumerIndex: number,
): Pick<CandidateAttribution, "immediate" | "pre_refinement" | "broad"> {
	return {
		immediate: producer.first_consumer_index === consumerIndex,
		pre_refinement: producer.next_search_index === undefined || consumerIndex < producer.next_search_index,
		broad: consumerIndex - producerIndex <= CALL_WINDOW && withinMillis(producer.producer, consumer, TIME_WINDOW_MS),
	};
}

function candidateObservations(
	producers: readonly ProducerObservation[],
	attributions: readonly CandidateAttribution[],
	level: CandidateLevel,
): CandidateObservation[] {
	const observed = new Map<NormalizedCandidate, CandidateObservation>();
	for (const producer of producers) {
		for (const candidate of level === "file" ? producer.file_candidates : producer.region_candidates) {
			observed.set(candidate, { producer: producer.producer, candidate,
				immediate: false, pre_refinement: false, productive: false, inspection: false, mutation: false });
		}
	}
	for (const item of attributions) {
		const candidate = level === "file" ? item.file_candidate : item.region_candidate;
		if (candidate === undefined) continue;
		// 归因保留规范化候选的原始引用，必定对应上面创建的观测。
		const value = observed.get(candidate) as CandidateObservation;
		if (item.broad && value.consumer === undefined) value.consumer = item.consumer;
		value.immediate ||= item.immediate;
		value.pre_refinement ||= item.pre_refinement;
		value.productive ||= level === "file" && item.productive;
		value.inspection ||= item.inspection;
		value.mutation ||= level === "file" && item.mutation;
	}
	return [...observed.values()];
}

function requireFileCandidate(producer: ProducerObservation, fileKey: string): NormalizedCandidate {
	const candidate = producer.file_candidates.find((item) => item.file_key === fileKey);
	if (candidate === undefined) throw new Error("Candidate normalization did not produce a file-level candidate.");
	return candidate;
}

/** 反向扫描只保留最近两个不同批次，避免逐个复制、搜索后缀。 */
function nextOutsideBatch(calls: readonly CallRecord[], accepts: (call: CallRecord) => boolean): Array<number | undefined> {
	const result: Array<number | undefined> = new Array(calls.length);
	let first: { call: CallRecord; index: number } | undefined;
	let second: typeof first;
	for (let index = calls.length - 1; index >= 0; index -= 1) {
		const call = calls[index];
		if (call === undefined) continue;
		result[index] = first !== undefined && sameBatch(call, first.call) ? second?.index : first?.index;
		if (!accepts(call)) continue;
		if (first !== undefined && !sameBatch(call, first.call)) second = first;
		first = { call, index };
	}
	return result;
}

function isConsumer(call: CallRecord): call is CallRecord & { targets: [Resource, ...Resource[]] } {
	return call.status === "success" && CONSUMER_TOOLS.has(call.tool)
		&& call.targets !== undefined && call.targets.length > 0;
}

function hasRange(resource: Resource): boolean {
	return resource.start_line !== undefined || resource.end_line !== undefined;
}

function rangesIntersect(left: Resource, right: Resource): boolean {
	if (!hasRange(left) || !hasRange(right)) return false;
	const leftStart = left.start_line ?? 1;
	const leftEnd = left.end_line ?? Number.POSITIVE_INFINITY;
	const rightStart = right.start_line ?? 1;
	const rightEnd = right.end_line ?? Number.POSITIVE_INFINITY;
	return leftStart <= rightEnd && rightStart <= leftEnd;
}

function rangeSize(resource: Resource): number {
	if (!hasRange(resource)) return Number.POSITIVE_INFINITY;
	return (resource.end_line ?? Number.MAX_SAFE_INTEGER) - (resource.start_line ?? 1);
}
