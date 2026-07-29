import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
	computeRepoMapActivation,
	evaluateRepoMapGate,
	type RepoMapActivation,
	type RepoMapActivationEntry,
} from "../runtime/activation.js";
import {
	RepoMapQueryIndex,
	type RepoMapQueryCandidate,
	type RepoMapQueryResult,
	type RepoMapReadActionCandidate,
	type RepoMapReadTestCandidate,
} from "./query.js";
import { analyzeRepoMapImpact, type AnalyzeRepoMapImpactInput, type RepoMapImpactResult } from "./impact.js";
import {
	DEFAULT_REPO_MAP_READ_SUGGESTION_LIMIT,
	DEFAULT_REPO_MAP_READ_TEST_LIMIT,
} from "../config/output-config.js";
import type { InitializeRepoMapResult, RefreshActivatedRepoMapInput } from "../runtime/service.js";
import type { RepoMapGeneration } from "../storage/storage.js";
import { isRepoMapPathInScope, relativeRepoPath } from "../config/scope.js";

export interface RepoMapReadContext {
	symbol: {
		id: string;
		kind: string;
		name?: string;
		qualifiedName?: string;
		startLine: number;
		endLine: number;
	};
	suggestedReads: Array<{
		path: string;
		line?: number;
		symbol?: string;
		relation: "caller" | "reference" | "registration";
	}>;
	suggestedTests: string[];
}

export interface RepoMapMutationResult {
	status: "updated" | "partially_stale";
	generation: string;
	diagnostic?: string;
	impact?: RepoMapImpactResult;
}

export interface RepoMapMutationInput {
	requestedPath: string;
	changedLine?: number;
	signal?: AbortSignal;
}

export interface RepoMapFileToolQuery {
	query(input: { requestedPath: string; query: string; limit: number; signal?: AbortSignal }): Promise<RepoMapQueryResult | undefined>;
	readContext(input: {
		requestedPath: string;
		contentHash: string;
		startLine: number;
		endLine: number;
		partial: boolean;
		truncated: boolean;
		suggestedReadLimit?: number;
		suggestedTestLimit?: number;
		signal?: AbortSignal;
	}): Promise<RepoMapReadContext | undefined>;
	syncMutation(input: RepoMapMutationInput): Promise<RepoMapMutationResult | undefined>;
	syncMutations?(inputs: readonly RepoMapMutationInput[]): Promise<readonly (RepoMapMutationResult | undefined)[]>;
}

export interface RepoMapFileToolQueryDependencies {
	readActivated(activation: RepoMapActivation): Promise<RepoMapGeneration | undefined>;
	refresh(input: RefreshActivatedRepoMapInput): Promise<InitializeRepoMapResult>;
	appendActivation(entry: RepoMapActivationEntry): void;
	now(): Date;
	analyzeImpact(input: AnalyzeRepoMapImpactInput): RepoMapImpactResult;
	createQueryIndex(generation: RepoMapGeneration): RepoMapQueryIndex;
	isMutationPathInScope(root: string, requestedPath: string): Promise<boolean>;
}

/** 未激活时只计算 session entry；磁盘读取、freshness 检查与查询均延后到调用时。 */
export function createRepoMapFileToolQuery(
	getBranch: () => SessionEntry[],
	dependencies: Partial<RepoMapFileToolQueryDependencies> = {},
): RepoMapFileToolQuery {
	const readActivated = dependencies.readActivated ?? (async (activation) =>
		await (await import("../runtime/service.js")).readActivatedRepoMapState(activation));
	const refresh = dependencies.refresh ?? (async (input) =>
		await (await import("../runtime/service.js")).refreshActivatedRepoMap(input));
	const now = dependencies.now ?? (() => new Date());
	const analyzeImpact = dependencies.analyzeImpact ?? analyzeRepoMapImpact;
	const createQueryIndex = dependencies.createQueryIndex ?? ((generation: RepoMapGeneration) => new RepoMapQueryIndex(generation));
	const isMutationPathInScope = dependencies.isMutationPathInScope ?? isRepoMapPathInScope;
	const queryIndexes = new Map<string, RepoMapQueryIndex>();
	interface PendingStaleRefresh {
		promise: Promise<{ activation: RepoMapActivation; generation: RepoMapGeneration } | undefined>;
		controller: AbortController;
		consumers: number;
		settled: boolean;
	}
	let staleRefresh: PendingStaleRefresh | undefined;
	const queryIndexFor = (generation: RepoMapGeneration): RepoMapQueryIndex => {
		const key = `${generation.metadata.repositoryRoot}\0${generation.metadata.mapId}\0${generation.metadata.generation}`;
		const cached = queryIndexes.get(key);
		if (cached !== undefined) {
			queryIndexes.delete(key);
			queryIndexes.set(key, cached);
			return cached;
		}
		const created = createQueryIndex(generation);
		queryIndexes.set(key, created);
		while (queryIndexes.size > 1) {
			const oldest = queryIndexes.keys().next().value;
			if (typeof oldest === "string") queryIndexes.delete(oldest);
		}
		return created;
	};

	const appendPartial = (activation: RepoMapActivation, diagnostic: string): void => {
		dependencies.appendActivation?.({
			kind: "activation",
			root: activation.root,
			mapId: activation.mapId,
			generation: activation.generation,
			activatedAt: now().toISOString(),
			freshness: "partially_stale",
			diagnostic,
		});
	};

	const refreshStale = (
		activation: RepoMapActivation,
		previous: RepoMapGeneration | undefined,
		signal?: AbortSignal,
	): Promise<{ activation: RepoMapActivation; generation: RepoMapGeneration } | undefined> => {
		let pending = staleRefresh;
		if (pending === undefined) {
			const controller = new AbortController();
			let created: PendingStaleRefresh;
			const promise = (async () => {
				const result = await refresh({
					activation,
					...(previous === undefined ? {} : { previous }),
					signal: controller.signal,
				});
				const entry: RepoMapActivationEntry = {
					kind: "activation",
					root: result.metadata.repositoryRoot,
					mapId: result.metadata.mapId,
					generation: result.metadata.generation,
					activatedAt: now().toISOString(),
					...(result.metadata.freshness !== "fresh" ? { freshness: result.metadata.freshness } : {}),
				};
				dependencies.appendActivation?.(entry);
				if (entry.generation !== activation.generation) queryIndexes.clear();
				return { activation: entry, generation: result.generation };
			})().finally(() => {
				created.settled = true;
				if (staleRefresh === created) staleRefresh = undefined;
			});
			created = { promise, controller, consumers: 0, settled: false };
			staleRefresh = created;
			pending = created;
		}
		pending.consumers += 1;
		return abortable(pending.promise, signal).finally(() => {
			pending.consumers -= 1;
			if (pending.consumers === 0 && !pending.settled) {
				if (staleRefresh === pending) staleRefresh = undefined;
				pending.controller.abort();
			}
		});
	};

	const loadEnabled = async (requestedPath: string, signal?: AbortSignal): Promise<{ activation: RepoMapActivation; generation: RepoMapGeneration } | undefined> => {
		throwIfQueryAborted(signal);
		let activation = computeRepoMapActivation(getBranch());
		if (activation === undefined) return undefined;
		const loadedGeneration = await abortable(readActivated(activation), signal);
		let generation = loadedGeneration === undefined
			|| activation.freshness === undefined
			|| loadedGeneration.metadata.freshness === "stale"
			|| loadedGeneration.metadata.freshness === "unavailable"
			? loadedGeneration
			: { ...loadedGeneration, metadata: { ...loadedGeneration.metadata, freshness: activation.freshness } };
		let gate = evaluateRepoMapGate({
			activation,
			...(generation === undefined ? {} : {
				map: {
					root: generation.metadata.repositoryRoot,
					mapId: generation.metadata.mapId,
					generation: generation.metadata.generation,
					freshness: generation.metadata.freshness,
				},
			}),
			requestedPath,
		});
		if (!gate.enabled && gate.reason === "map_stale") {
			const refreshed = await refreshStale(activation, generation, signal);
			if (refreshed === undefined) return undefined;
			({ activation, generation } = refreshed);
			gate = evaluateRepoMapGate({
				activation,
				map: {
					root: generation.metadata.repositoryRoot,
					mapId: generation.metadata.mapId,
					generation: generation.metadata.generation,
					freshness: generation.metadata.freshness,
				},
				requestedPath,
			});
		}
		return gate.enabled && generation !== undefined ? { activation, generation } : undefined;
	};

	const syncMutations = async (
		inputs: readonly RepoMapMutationInput[],
	): Promise<readonly (RepoMapMutationResult | undefined)[]> => {
		if (inputs.length === 0) return [];
		const activation = computeRepoMapActivation(getBranch());
		if (activation === undefined) return inputs.map(() => undefined);
		const changedPaths = inputs.map((input) => relativeRepoPath(activation.root, input.requestedPath));
		if (changedPaths.every((changedPath) => changedPath === undefined)) return inputs.map(() => undefined);
		let included = changedPaths.map((changedPath) => changedPath !== undefined);
		try {
			const before = await readActivated(activation).catch(() => undefined);
			included = await Promise.all(inputs.map(async (input, index) => {
				const changedPath = changedPaths[index];
				if (changedPath === undefined) return false;
				if (before?.files.some((file) => file.path === changedPath)) return true;
				try {
					return await isMutationPathInScope(activation.root, input.requestedPath);
				} catch {
					// 无法证明变更与索引无关时保留刷新行为。
					return true;
				}
			}));
			if (!included.some(Boolean)) return inputs.map(() => undefined);
			const sharedSignal = inputs.length === 1 ? inputs[0]?.signal : undefined;
			const result = await refresh({
				activation,
				...(before === undefined ? {} : { previous: before }),
				...(sharedSignal === undefined ? {} : { signal: sharedSignal }),
			});
			const entry: RepoMapActivationEntry = {
				kind: "activation",
				root: result.metadata.repositoryRoot,
				mapId: result.metadata.mapId,
				generation: result.metadata.generation,
				activatedAt: now().toISOString(),
				...(result.metadata.freshness !== "fresh" ? { freshness: result.metadata.freshness } : {}),
			};
			dependencies.appendActivation?.(entry);
			if (result.metadata.generation !== activation.generation) queryIndexes.clear();
			const base: RepoMapMutationResult = {
				status: result.metadata.freshness === "fresh" ? "updated" : "partially_stale",
				generation: result.metadata.generation,
			};
			const after = result.generation;
			return await Promise.all(inputs.map(async (input, index) => {
				if (!included[index]) return undefined;
				const mutation: RepoMapMutationResult = { ...base };
				const refreshedPath = relativeRepoPath(result.metadata.repositoryRoot, input.requestedPath);
				if (refreshedPath === undefined) return mutation;
				try {
					const impact = analyzeImpact({
						...(before === undefined ? {} : { before }),
						after,
						changedPath: refreshedPath,
						...(input.changedLine === undefined ? {} : { changedLine: input.changedLine }),
						maxCandidates: 8,
					});
					mutation.impact = await verifiedImpact(after, impact, inputs.length === 1 ? input.signal : undefined);
				} catch {
					// 单个文件的影响分析失败不影响同批次其他结果。
				}
				return mutation;
			}));
		} catch (error) {
			const diagnostic = error instanceof Error ? error.message : "Repo Map update failed.";
			appendPartial(activation, diagnostic);
			return inputs.map((_input, index) => included[index]
				? { status: "partially_stale", generation: activation.generation, diagnostic }
				: undefined);
		}
	};

	return {
		async query(input) {
			try {
				const loaded = await loadEnabled(input.requestedPath, input.signal);
				if (loaded === undefined) return undefined;
				throwIfQueryAborted(input.signal);
				const result = queryIndexFor(loaded.generation).candidates(input.query, input.limit);
				const candidates = await verifiedCandidates(loaded.generation, result.candidates, input.signal);
				throwIfQueryAborted(input.signal);
				if (candidates.length !== result.candidates.length) {
					appendPartial(loaded.activation, "Repo Map candidate hash differs from the live file.");
				}
				return { ...result, candidates };
			} catch {
				return undefined;
			}
		},
		async readContext(input) {
			if (!input.partial && !input.truncated) return undefined;
			try {
				const loaded = await loadEnabled(input.requestedPath, input.signal);
				if (loaded === undefined) return undefined;
				const relativePath = relativeRepoPath(loaded.activation.root, input.requestedPath);
				if (relativePath === undefined) return undefined;
				const queryIndex = queryIndexFor(loaded.generation);
				const file = queryIndex.file(relativePath);
				if (file?.status !== "indexed" || file.contentHash === undefined) return undefined;
				if (file.contentHash !== input.contentHash) {
					appendPartial(loaded.activation, "Repo Map file hash differs from the live read.");
					return undefined;
				}
				const readLimit = Math.max(0, input.suggestedReadLimit ?? DEFAULT_REPO_MAP_READ_SUGGESTION_LIMIT);
				const testLimit = Math.max(0, input.suggestedTestLimit ?? DEFAULT_REPO_MAP_READ_TEST_LIMIT);
				const actions = queryIndex.readActions({
					fileId: file.id,
					startLine: input.startLine,
					endLine: input.endLine,
					readLimit,
					testLimit,
				});
				if (actions === undefined) return undefined;
				const verified = await verifiedReadActions(
					loaded.generation,
					actions.suggestedReads,
					actions.suggestedTests,
					input.signal,
				);
				if (verified.suggestedReads.length !== actions.suggestedReads.length
					|| verified.suggestedTests.length !== actions.suggestedTests.length) {
					appendPartial(loaded.activation, "Repo Map read action hash differs from the live file.");
				}
				const suggestedReads = verified.suggestedReads.slice(0, readLimit).map((candidate) => ({
					path: candidate.path,
					...(candidate.line === undefined ? {} : { line: candidate.line }),
					...(candidate.symbol === undefined ? {} : { symbol: candidate.symbol }),
					relation: candidate.relation,
				}));
				const suggestedTests = verified.suggestedTests.slice(0, testLimit).map((candidate) => candidate.path);
				if (suggestedReads.length === 0 && suggestedTests.length === 0) return undefined;
				const symbol = actions.symbol;
				return {
					symbol: {
						id: symbol.id,
						kind: symbol.symbolKind,
						...(symbol.name === undefined ? {} : { name: symbol.name }),
						...(symbol.qualifiedName === undefined ? {} : { qualifiedName: symbol.qualifiedName }),
						startLine: symbol.startLine,
						endLine: symbol.endLine,
					},
					suggestedReads,
					suggestedTests,
				};
			} catch {
				return undefined;
			}
		},
		async syncMutation(input) {
			return (await syncMutations([input]))[0];
		},
		syncMutations,
	};
}

async function verifiedCandidates(
	generation: RepoMapGeneration,
	candidates: RepoMapQueryCandidate[],
	signal?: AbortSignal,
): Promise<RepoMapQueryCandidate[]> {
	const results = new Map<string, boolean>();
	const verify = async (file: { path: string; contentHash?: string }): Promise<boolean> => {
		throwIfQueryAborted(signal);
		if (file.contentHash === undefined) return false;
		const key = `${file.path}\0${file.contentHash}`;
		const cached = results.get(key);
		if (cached !== undefined) return cached;
		const valid = await hashFile(path.join(generation.metadata.repositoryRoot, file.path), signal) === file.contentHash;
		results.set(key, valid);
		return valid;
	};
	const verified: RepoMapQueryCandidate[] = [];
	for (const candidate of candidates) {
		if (!await verify(candidate)) continue;
		const related = candidate.relatedEdges.flatMap((edge) => edge.relatedFiles);
		const aliasEvidence = candidate.matchedAliases.flatMap((alias) => alias.evidence.flatMap((evidence) =>
			evidence.textHash === undefined ? [] : [{ path: evidence.path, contentHash: evidence.textHash }]));
		if ((await Promise.all([...related, ...aliasEvidence].map(verify))).every(Boolean)) verified.push(candidate);
	}
	return verified;
}

async function hashFile(filePath: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		throwIfQueryAborted(signal);
		const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const content = signal === undefined ? await handle.readFile() : await handle.readFile({ signal });
			return createHash("sha256").update(content).digest("hex");
		} finally {
			await handle.close();
		}
	} catch {
		throwIfQueryAborted(signal);
		return undefined;
	}
}

async function verifiedReadActions(
	generation: RepoMapGeneration,
	reads: readonly RepoMapReadActionCandidate[],
	tests: readonly RepoMapReadTestCandidate[],
	signal?: AbortSignal,
): Promise<{ suggestedReads: RepoMapReadActionCandidate[]; suggestedTests: RepoMapReadTestCandidate[] }> {
	const verifications = new Map<string, Promise<boolean>>();
	const verify = (candidate: { path: string; contentHash?: string }): Promise<boolean> => {
		throwIfQueryAborted(signal);
		if (candidate.contentHash === undefined) return Promise.resolve(false);
		const key = `${candidate.path}\0${candidate.contentHash}`;
		const cached = verifications.get(key);
		if (cached !== undefined) return cached;
		const pending = hashFile(path.join(generation.metadata.repositoryRoot, candidate.path), signal)
			.then((hash) => hash === candidate.contentHash);
		verifications.set(key, pending);
		return pending;
	};
	const [readValidity, testValidity] = await Promise.all([
		Promise.all(reads.map(verify)),
		Promise.all(tests.map(verify)),
	]);
	return {
		suggestedReads: reads.filter((_candidate, index) => readValidity[index]),
		suggestedTests: tests.filter((_candidate, index) => testValidity[index]),
	};
}

async function verifiedImpact(generation: RepoMapGeneration, impact: RepoMapImpactResult, signal?: AbortSignal): Promise<RepoMapImpactResult> {
	const candidates = [];
	for (const candidate of impact.candidates) {
		if (candidate.contentHash === undefined || await hashFile(path.join(generation.metadata.repositoryRoot, candidate.path), signal) !== candidate.contentHash) continue;
		candidates.push(candidate);
	}
	return { ...impact, candidates };
}

class RepoMapQueryAbortedError extends Error {}

function throwIfQueryAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw new RepoMapQueryAbortedError();
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return promise;
	throwIfQueryAborted(signal);
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(new RepoMapQueryAbortedError());
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}
