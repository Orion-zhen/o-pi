import pLimit from "p-limit";

import type { DirectoryRef, FileRef } from "../../filesystem/contracts/path.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { EMPTY_RANKING_EVIDENCE } from "../shared/ranking/evidence.js";
import { createFindEntry, type RankedFindEntry } from "./ranker.js";
import { graphEvidenceTier, graphNavigationRelation, graphRankingEvidence, isGraphMainCandidate, isGraphNavigationCandidate } from "./graph-ranking.js";
import type { FindGraphCandidate, FindGraphSource } from "./graph-source.js";
import type { FindRelatedResult } from "./types.js";

interface ValidatedGraphEntry extends RankedFindEntry {
	readonly candidate: FindGraphCandidate;
	readonly matchesQuery: boolean;
	readonly navigation: boolean;
	readonly graphOrder: number;
	readonly relation?: string;
}

export interface GraphCandidates {
	readonly matching: RankedFindEntry[];
	readonly related: FindRelatedResult[];
}

export interface FindGraphCandidateContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly resultLimit: number;
	readonly graph?: FindGraphSource;
}

const VALIDATION_CONCURRENCY = 8;
const RELATED_LIMIT = 3;

/** Treats graph output as untrusted and revalidates every filesystem fact live. */
export async function findGraphCandidates(
	searchRoot: DirectoryRef,
	query: string,
	context: FindGraphCandidateContext,
): Promise<GraphCandidates> {
	if (context.graph === undefined) return emptyGraphCandidates();
	try {
		const queried = await context.graph.query({
			root: searchRoot,
			query,
			limit: Math.max(24, context.resultLimit * 4),
			...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
		});
		if (queried === undefined) return emptyGraphCandidates();
		const rootVisibility = await context.filesystem.visibility.evaluate(searchRoot, "search", context.operation);
		if (!rootVisibility.ok) return emptyGraphCandidates();
		const bypassVisibility = rootVisibility.value.ignored;
		const hashes = new Map<string, Promise<string | undefined>>();
		const limit = pLimit(VALIDATION_CONCURRENCY);
		const validated = await Promise.all(queried.candidates.map((candidate, order) => limit(async () =>
			await validateCandidate(candidate, order, queried.root, searchRoot, query, bypassVisibility, hashes, context))));
		return partitionCandidates(validated.filter((candidate): candidate is ValidatedGraphEntry => candidate !== undefined));
	} catch {
		if (context.operation.signal?.aborted === true) throw new AbortFindGraph();
		return emptyGraphCandidates();
	}
}

async function validateCandidate(
	candidate: FindGraphCandidate,
	order: number,
	graphRoot: DirectoryRef,
	searchRoot: DirectoryRef,
	query: string,
	bypassVisibility: boolean,
	hashes: Map<string, Promise<string | undefined>>,
	context: FindGraphCandidateContext,
): Promise<ValidatedGraphEntry | undefined> {
	if (context.operation.signal?.aborted === true) throw new AbortFindGraph();
	const resolved = await resolveGraphFile(graphRoot, candidate.path, context);
	if (resolved === undefined
		|| !context.filesystem.paths.isWithin(context.filesystem.root, resolved)
		|| !context.filesystem.paths.isWithin(searchRoot, resolved)) return undefined;
	if (!bypassVisibility) {
		const visibility = await context.filesystem.visibility.evaluate(resolved, "search", context.operation);
		if (!visibility.ok || visibility.value.ignored) return undefined;
	}
	if (!await matchesCurrentHash(resolved, candidate.contentHash, hashes, context)) return undefined;
	for (const related of candidate.relatedEdges.flatMap((edge) => edge.relatedFiles)) {
		const relatedRef = await resolveGraphFile(graphRoot, related.path, context);
		if (relatedRef === undefined || !context.filesystem.paths.isWithin(searchRoot, relatedRef)
			|| !await matchesCurrentHash(relatedRef, related.contentHash, hashes, context)) return undefined;
	}
	const matchesQuery = isGraphMainCandidate(candidate, query);
	const relation = graphNavigationRelation(candidate);
	const baseTier = graphEvidenceTier(candidate);
	const tier = !hasTestIntent(query) && !/[A-Z]/u.test(query) && isTestLikeCandidate(candidate) ? Math.max(5, baseTier) : baseTier;
	return {
		candidate,
		entry: createFindEntry(resolved.displayPath, "file"),
		tier,
		evidence: EMPTY_RANKING_EVIDENCE,
		matchesQuery,
		navigation: isGraphNavigationCandidate(candidate),
		graphOrder: order,
		...(relation === undefined ? {} : { relation }),
	};
}

async function resolveGraphFile(
	root: DirectoryRef,
	candidatePath: string,
	context: FindGraphCandidateContext,
): Promise<FileRef | undefined> {
	const resolved = await context.filesystem.paths.resolveExisting(
		joinDisplayPath(root.displayPath, candidatePath),
		{ expected: "file", followFinalSymlink: false },
		context.operation,
	);
	return resolved.ok && resolved.value.kind === "file" ? resolved.value : undefined;
}

async function matchesCurrentHash(
	file: FileRef,
	expected: string | undefined,
	cache: Map<string, Promise<string | undefined>>,
	context: FindGraphCandidateContext,
): Promise<boolean> {
	if (expected === undefined) return false;
	let pending = cache.get(file.id);
	if (pending === undefined) {
		pending = (async () => {
			const content = await context.filesystem.content.readBytes(file, { stable: true }, context.operation);
			return content.ok ? content.value.hash : undefined;
		})();
		cache.set(file.id, pending);
	}
	const actual = await pending;
	return actual === expected || actual === `sha256:${expected}`;
}

function partitionCandidates(candidates: readonly ValidatedGraphEntry[]): GraphCandidates {
	const matching = candidates.filter((candidate) => candidate.matchesQuery);
	for (const [index, candidate] of matching.entries()) candidate.evidence = graphRankingEvidence(candidate.candidate, index + 1);
	const relatedByPath = new Map<string, { result: FindRelatedResult; order: number }>();
	for (const candidate of candidates) {
		if (candidate.matchesQuery || !candidate.navigation || candidate.relation === undefined) continue;
		const existing = relatedByPath.get(candidate.entry.path);
		if (existing === undefined) {
			relatedByPath.set(candidate.entry.path, {
				result: { path: candidate.entry.path, kind: "file", source: "repo-map", relations: [candidate.relation], query_match: "not_guaranteed" },
				order: candidate.graphOrder,
			});
			continue;
		}
		if (existing.result.relations.length < 2 && !existing.result.relations.includes(candidate.relation)) existing.result.relations.push(candidate.relation);
		existing.order = Math.min(existing.order, candidate.graphOrder);
	}
	return {
		matching,
		related: [...relatedByPath.values()]
			.sort((left, right) => left.order - right.order || compareStableString(left.result.path, right.result.path))
			.slice(0, RELATED_LIMIT)
			.map((item) => item.result),
	};
}

function emptyGraphCandidates(): GraphCandidates {
	return { matching: [], related: [] };
}

function joinDisplayPath(parent: string, child: string): string {
	const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
	return parent === "." ? child : parent.endsWith(separator) ? `${parent}${child}` : `${parent}${separator}${child}`;
}

function hasTestIntent(query: string): boolean {
	return /(?:^|[^a-z0-9])(?:tests?|specs?|fixtures?|mocks?)(?:$|[^a-z0-9])/iu.test(query);
}

function isTestLikeCandidate(candidate: FindGraphCandidate): boolean {
	return candidate.reasons.some((reason) => reason === "test" || reason === "mock" || reason === "fixture" || reason === "snapshot" || reason === "test config")
		|| /(?:^|\/)(?:tests?|fixtures?|mocks?)(?:\/|$)|(?:\.|-)(?:test|spec)\.[^/]+$/iu.test(candidate.path);
}

export class AbortFindGraph extends Error {}

function compareStableString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
