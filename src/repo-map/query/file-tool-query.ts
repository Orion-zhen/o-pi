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
import { RepoMapQueryIndex, type RepoMapQueryCandidate, type RepoMapQueryResult } from "./query.js";
import { analyzeRepoMapImpact, type AnalyzeRepoMapImpactInput, type RepoMapImpactResult } from "./impact.js";
import { REPO_MAP_OUTPUT_CANDIDATE_LIMIT } from "../config/output-config.js";
import type { InitializeRepoMapResult, RefreshActivatedRepoMapInput } from "../runtime/service.js";
import type { RepoMapGeneration } from "../storage/storage.js";
import { isRepoMapPathInScope, relativeRepoPath } from "../config/scope.js";
import type { RepoMapEdge, RepoMapEntrypointNode, RepoMapSymbolNode } from "../core/types.js";

export interface RepoMapReadContext {
	symbol: {
		id: string;
		kind: string;
		name?: string;
		qualifiedName?: string;
		startLine: number;
		endLine: number;
	};
	callers: string[];
	callees: string[];
	references: string[];
	imports: string[];
	package?: string;
	component?: string;
	entrypoints?: string[];
	publicApi?: boolean;
	relatedTests?: string[];
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
		signal?: AbortSignal,
	): Promise<{ activation: RepoMapActivation; generation: RepoMapGeneration } | undefined> => {
		let pending = staleRefresh;
		if (pending === undefined) {
			const controller = new AbortController();
			let created: PendingStaleRefresh;
			const promise = (async () => {
				const result = await refresh({ activation, signal: controller.signal });
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
				const generation = await readActivated(entry);
				return generation === undefined ? undefined : { activation: entry, generation };
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
			const refreshed = await refreshStale(activation, signal);
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
			let after: RepoMapGeneration | undefined;
			try {
				after = await readActivated({
					root: result.metadata.repositoryRoot,
					mapId: result.metadata.mapId,
					generation: result.metadata.generation,
					activatedAt: result.metadata.updatedAt,
					freshness: result.metadata.freshness,
				});
			} catch {
				// 影响分析是附加信息，不能改变已成功的刷新结果。
			}
			return await Promise.all(inputs.map(async (input, index) => {
				if (!included[index]) return undefined;
				const mutation: RepoMapMutationResult = { ...base };
				const refreshedPath = relativeRepoPath(result.metadata.repositoryRoot, input.requestedPath);
				if (after === undefined || refreshedPath === undefined) return mutation;
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
				const file = loaded.generation.files.find((candidate) => candidate.path === relativePath);
				if (file?.status !== "indexed" || file.contentHash === undefined) return undefined;
				if (file.contentHash !== input.contentHash) {
					appendPartial(loaded.activation, "Repo Map file hash differs from the live read.");
					return undefined;
				}
				const context = contextForRange(loaded.generation, file.id, input.startLine, input.endLine);
				if (context === undefined) return undefined;
				const queryIndex = queryIndexFor(loaded.generation);
				const directTests = await verifiedCandidates(loaded.generation, queryIndex.relatedTests(
					[file.id, context.symbol.id],
					REPO_MAP_OUTPUT_CANDIDATE_LIMIT,
				), input.signal);
				return directTests.length === 0
					? context
					: { ...context, relatedTests: [...new Set(directTests.map((candidate) => candidate.path))].slice(0, REPO_MAP_OUTPUT_CANDIDATE_LIMIT) };
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

function contextForRange(generation: RepoMapGeneration, fileId: string, startLine: number, endLine: number): RepoMapReadContext | undefined {
	const symbols = generation.symbols
		.filter((symbol) => symbol.fileId === fileId && symbol.startLine <= endLine && symbol.endLine >= startLine)
		.sort((left, right) => enclosingRank(left, startLine, endLine) - enclosingRank(right, startLine, endLine)
			|| (left.endLine - left.startLine) - (right.endLine - right.startLine)
			|| left.startLine - right.startLine);
	const symbol = symbols[0];
	if (symbol === undefined) return undefined;
	const symbolsById = new Map(generation.symbols.map((candidate) => [candidate.id, candidate]));
	const filesById = new Map(generation.files.map((file) => [file.id, file.path]));
	const architectureById = new Map(generation.architecture.map((node) => [node.id, node]));
	const label = (id: string): string | undefined => {
		const related = symbolsById.get(id);
		if (related === undefined) return filesById.get(id);
		const filePath = filesById.get(related.fileId);
		const name = related.qualifiedName ?? related.name;
		return compactLabel(name === undefined ? filePath : filePath === undefined ? name : `${filePath}:${name}`);
	};
	const ownership = generation.edges.filter((edge) => edge.kind === "belongs-to" && (edge.from === fileId || edge.from === symbol.id));
	const packageNode = ownership.flatMap((edge) => architectureById.get(edge.to) ?? []).find((node) => node.kind === "package");
	const componentNode = ownership.flatMap((edge) => architectureById.get(edge.to) ?? []).find((node) => node.kind === "component");
	const entrypoints = [...architectureById.values()]
		.filter((node): node is RepoMapEntrypointNode => node.kind === "entrypoint" && node.fileId === fileId)
		.map((node) => `${node.entrypointType}:${node.name}`)
		.sort()
		.slice(0, REPO_MAP_OUTPUT_CANDIDATE_LIMIT);
	const exported = symbol.visibility === "public" || generation.edges.some((edge) => (edge.kind === "exports" || edge.kind === "exports-publicly") && edge.to === symbol.id);
	return {
		symbol: {
			id: symbol.id,
			kind: symbol.symbolKind,
			...(symbol.name !== undefined ? { name: symbol.name } : {}),
			...(symbol.qualifiedName !== undefined ? { qualifiedName: symbol.qualifiedName } : {}),
			startLine: symbol.startLine,
			endLine: symbol.endLine,
		},
		callers: relationLabels(generation.edges, (edge) => edge.kind === "calls" && edge.to === symbol.id, (edge) => edge.from, label),
		callees: relationLabels(generation.edges, (edge) => edge.kind === "calls" && edge.from === symbol.id, (edge) => edge.to, label),
		references: relationLabels(generation.edges, (edge) => edge.kind === "references" && edge.to === symbol.id, (edge) => edge.from, label),
		imports: relationLabels(generation.edges, (edge) => edge.kind === "imports" && edge.from === fileId, (edge) => edge.to, label),
		...(packageNode?.kind === "package" ? { package: packageNode.name } : {}),
		...(componentNode?.kind === "component" ? { component: componentNode.name } : {}),
		...(entrypoints.length > 0 ? { entrypoints } : {}),
		...(exported ? { publicApi: true } : {}),
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

function relationLabels(
	edges: readonly RepoMapEdge[],
	include: (edge: RepoMapEdge) => boolean,
	target: (edge: RepoMapEdge) => string,
	label: (id: string) => string | undefined,
): string[] {
	return Array.from(new Set(edges.filter(include).flatMap((edge) => label(target(edge)) ?? [])))
		.sort()
		.slice(0, REPO_MAP_OUTPUT_CANDIDATE_LIMIT);
}

function compactLabel(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return value.length <= 96 ? value : `${value.slice(0, 93)}...`;
}

function enclosingRank(symbol: RepoMapSymbolNode, startLine: number, endLine: number): number {
	return symbol.startLine <= startLine && symbol.endLine >= endLine ? 0 : 1;
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
