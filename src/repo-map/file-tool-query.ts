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
} from "./activation.js";
import { RepoMapQueryIndex, type RepoMapQueryCandidate, type RepoMapQueryResult } from "./query.js";
import { analyzeRepoMapImpact, type AnalyzeRepoMapImpactInput, type RepoMapImpactResult } from "./impact.js";
import type { InitializeRepoMapResult, RefreshActivatedRepoMapInput } from "./service.js";
import type { RepoMapGeneration } from "./storage.js";
import type { RepoMapEdge, RepoMapEntrypointNode, RepoMapSymbolNode } from "./types.js";

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

export interface RepoMapFileToolQuery {
	query(input: { requestedPath: string; query: string; limit: number }): Promise<RepoMapQueryResult | undefined>;
	readContext(input: {
		requestedPath: string;
		contentHash: string;
		startLine: number;
		endLine: number;
		partial: boolean;
		truncated: boolean;
	}): Promise<RepoMapReadContext | undefined>;
	syncMutation(input: { requestedPath: string; changedLine?: number; signal?: AbortSignal }): Promise<RepoMapMutationResult | undefined>;
}

export interface RepoMapFileToolQueryDependencies {
	readActivated(activation: RepoMapActivation): Promise<RepoMapGeneration | undefined>;
	refresh(input: RefreshActivatedRepoMapInput): Promise<InitializeRepoMapResult>;
	appendActivation(entry: RepoMapActivationEntry): void;
	now(): Date;
	analyzeImpact(input: AnalyzeRepoMapImpactInput): RepoMapImpactResult;
	createQueryIndex(generation: RepoMapGeneration): RepoMapQueryIndex;
}

/** 未激活时只计算 session entry；磁盘读取、freshness 检查与查询均延后到调用时。 */
export function createRepoMapFileToolQuery(
	getBranch: () => SessionEntry[],
	dependencies: Partial<RepoMapFileToolQueryDependencies> = {},
): RepoMapFileToolQuery {
	const readActivated = dependencies.readActivated ?? (async (activation) =>
		await (await import("./service.js")).readActivatedRepoMapState(activation));
	const refresh = dependencies.refresh ?? (async (input) =>
		await (await import("./service.js")).refreshActivatedRepoMap(input));
	const now = dependencies.now ?? (() => new Date());
	const analyzeImpact = dependencies.analyzeImpact ?? analyzeRepoMapImpact;
	const createQueryIndex = dependencies.createQueryIndex ?? ((generation: RepoMapGeneration) => new RepoMapQueryIndex(generation));
	const queryIndexes = new Map<string, RepoMapQueryIndex>();
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

	const loadEnabled = async (requestedPath: string): Promise<{ activation: RepoMapActivation; generation: RepoMapGeneration } | undefined> => {
		const activation = computeRepoMapActivation(getBranch());
		if (activation === undefined) return undefined;
		const loadedGeneration = await readActivated(activation);
		const generation = loadedGeneration === undefined
			|| activation.freshness === undefined
			|| loadedGeneration.metadata.freshness === "stale"
			|| loadedGeneration.metadata.freshness === "unavailable"
			? loadedGeneration
			: { ...loadedGeneration, metadata: { ...loadedGeneration.metadata, freshness: activation.freshness } };
		const gate = evaluateRepoMapGate({
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
		return gate.enabled && generation !== undefined ? { activation, generation } : undefined;
	};

	return {
		async query(input) {
			try {
				const loaded = await loadEnabled(input.requestedPath);
				if (loaded === undefined) return undefined;
				const result = queryIndexFor(loaded.generation).candidates(input.query, input.limit);
				const candidates = await verifiedCandidates(loaded.generation, result.candidates);
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
				const loaded = await loadEnabled(input.requestedPath);
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
				const directTests = await verifiedCandidates(loaded.generation, queryIndex.relatedTests([file.id, context.symbol.id], 4));
				return directTests.length === 0
					? context
					: { ...context, relatedTests: [...new Set(directTests.map((candidate) => candidate.path))].slice(0, 2) };
			} catch {
				return undefined;
			}
		},
		async syncMutation(input) {
			const activation = computeRepoMapActivation(getBranch());
			if (activation === undefined || relativeRepoPath(activation.root, input.requestedPath) === undefined) return undefined;
			try {
				const before = await readActivated(activation).catch(() => undefined);
				const result = await refresh({
					activation,
					...(input.signal !== undefined ? { signal: input.signal } : {}),
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
				const mutation: RepoMapMutationResult = {
					status: result.metadata.freshness === "fresh" ? "updated" : "partially_stale",
					generation: result.metadata.generation,
				};
				try {
					const after = await readActivated({
						root: result.metadata.repositoryRoot,
						mapId: result.metadata.mapId,
						generation: result.metadata.generation,
						activatedAt: result.metadata.updatedAt,
						freshness: result.metadata.freshness,
					});
					const changedPath = relativeRepoPath(result.metadata.repositoryRoot, input.requestedPath);
					if (after !== undefined && changedPath !== undefined) {
						const impact = analyzeImpact({
							...(before !== undefined ? { before } : {}),
							after,
							changedPath,
							...(input.changedLine !== undefined ? { changedLine: input.changedLine } : {}),
							maxCandidates: 8,
						});
						mutation.impact = await verifiedImpact(after, impact);
					}
				} catch {
					// Impact analysis is advisory and cannot change a successful map refresh.
				}
				return mutation;
			} catch (error) {
				const diagnostic = error instanceof Error ? error.message : "Repo Map update failed.";
				appendPartial(activation, diagnostic);
				return { status: "partially_stale", generation: activation.generation, diagnostic };
			}
		},
	};
}

async function verifiedCandidates(generation: RepoMapGeneration, candidates: RepoMapQueryCandidate[]): Promise<RepoMapQueryCandidate[]> {
	const results = new Map<string, boolean>();
	const verify = async (file: { path: string; contentHash?: string }): Promise<boolean> => {
		if (file.contentHash === undefined) return false;
		const key = `${file.path}\0${file.contentHash}`;
		const cached = results.get(key);
		if (cached !== undefined) return cached;
		const valid = await hashFile(path.join(generation.metadata.repositoryRoot, file.path)) === file.contentHash;
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

async function hashFile(filePath: string): Promise<string | undefined> {
	try {
		const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			return createHash("sha256").update(await handle.readFile()).digest("hex");
		} finally {
			await handle.close();
		}
	} catch {
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
		.slice(0, 2);
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

async function verifiedImpact(generation: RepoMapGeneration, impact: RepoMapImpactResult): Promise<RepoMapImpactResult> {
	const candidates = [];
	for (const candidate of impact.candidates) {
		if (candidate.contentHash === undefined || await hashFile(path.join(generation.metadata.repositoryRoot, candidate.path)) !== candidate.contentHash) continue;
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
	return Array.from(new Set(edges.filter(include).flatMap((edge) => label(target(edge)) ?? []))).sort().slice(0, 2);
}

function compactLabel(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return value.length <= 96 ? value : `${value.slice(0, 93)}...`;
}

function enclosingRank(symbol: RepoMapSymbolNode, startLine: number, endLine: number): number {
	return symbol.startLine <= startLine && symbol.endLine >= endLine ? 0 : 1;
}

function relativeRepoPath(root: string, requestedPath: string): string | undefined {
	const relative = path.relative(path.resolve(root), path.resolve(requestedPath));
	if (relative === "") return undefined;
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
	return relative.replaceAll(path.sep, "/");
}
