import pLimit from "p-limit";

import type { DirectoryRef, FileRef } from "../../filesystem/contracts/path.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { EMPTY_RANKING_EVIDENCE } from "../shared/ranking/evidence.js";
import { createFindEntry, type RankedFindEntry } from "./ranker.js";
import { graphEvidenceTier, graphRankingEvidence, isGraphFallbackCandidate } from "./graph-ranking.js";
import type { FindGraphCandidate, FindGraphSource } from "./graph-source.js";

interface ValidatedGraphEntry extends RankedFindEntry {
	readonly candidate: FindGraphCandidate;
}

export interface GraphCandidates {
	readonly ranking: RankedFindEntry[];
	readonly fallback: RankedFindEntry[];
}

export interface FindGraphCandidateContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly resultLimit: number;
	readonly maxDepth: number;
	readonly graph?: FindGraphSource;
}

const VALIDATION_CONCURRENCY = 8;

/** Treats graph output as untrusted and revalidates every filesystem fact live. */
export async function findGraphCandidates(
	searchRoot: DirectoryRef,
	query: string,
	context: FindGraphCandidateContext,
): Promise<GraphCandidates> {
	if (context.graph === undefined || !Number.isSafeInteger(context.maxDepth) || context.maxDepth < 0) return emptyGraphCandidates();
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
		const resolvedFiles = new Map<string, Promise<FileRef | undefined>>();
		const hashes = new Map<string, Promise<string | undefined>>();
		const limit = pLimit(VALIDATION_CONCURRENCY);
		const validated = await Promise.all(queried.candidates.map((candidate) => limit(async () =>
			await validateCandidate(candidate, queried.root, searchRoot, query, bypassVisibility, resolvedFiles, hashes, context))));
		return partitionCandidates(validated.filter((candidate): candidate is ValidatedGraphEntry => candidate !== undefined));
	} catch {
		if (context.operation.signal?.aborted === true) throw new AbortFindGraph();
		return emptyGraphCandidates();
	}
}

async function validateCandidate(
	candidate: FindGraphCandidate,
	graphRoot: DirectoryRef,
	searchRoot: DirectoryRef,
	query: string,
	bypassVisibility: boolean,
	resolvedFiles: Map<string, Promise<FileRef | undefined>>,
	hashes: Map<string, Promise<string | undefined>>,
	context: FindGraphCandidateContext,
): Promise<ValidatedGraphEntry | undefined> {
	if (context.operation.signal?.aborted === true) throw new AbortFindGraph();
	const resolved = await resolveGraphFile(graphRoot, candidate.path, resolvedFiles, context);
	if (resolved === undefined || !context.filesystem.paths.isWithin(context.filesystem.root, resolved)) return undefined;
	const relativePath = context.filesystem.paths.relative(searchRoot, resolved);
	if (relativePath === undefined || pathDepth(relativePath) > context.maxDepth) return undefined;
	if (!bypassVisibility) {
		const visibility = await context.filesystem.visibility.evaluate(resolved, "search", context.operation);
		if (!visibility.ok || visibility.value.ignored) return undefined;
	}
	if (!await matchesCurrentHash(resolved, candidate.contentHash, hashes, context)) return undefined;
	for (const related of candidate.relatedEdges.flatMap((edge) => edge.relatedFiles)) {
		const relatedRef = await resolveGraphFile(graphRoot, related.path, resolvedFiles, context);
		if (relatedRef === undefined || context.filesystem.paths.relative(searchRoot, relatedRef) === undefined
			|| !await matchesCurrentHash(relatedRef, related.contentHash, hashes, context)) return undefined;
	}
	const baseTier = graphEvidenceTier(candidate);
	const tier = !hasTestIntent(query) && !/[A-Z]/u.test(query) && isTestLikeCandidate(candidate) ? Math.max(5, baseTier) : baseTier;
	return {
		candidate,
		entry: createFindEntry(resolved.displayPath, "file"),
		tier,
		evidence: EMPTY_RANKING_EVIDENCE,
	};
}

async function resolveGraphFile(
	root: DirectoryRef,
	candidatePath: string,
	cache: Map<string, Promise<FileRef | undefined>>,
	context: FindGraphCandidateContext,
): Promise<FileRef | undefined> {
	let pending = cache.get(candidatePath);
	if (pending === undefined) {
		pending = (async () => {
			const resolved = await context.filesystem.paths.resolveExisting(
				joinDisplayPath(root.displayPath, candidatePath),
				{ expected: "file", followFinalSymlink: false },
				context.operation,
			);
			return resolved.ok && resolved.value.kind === "file" ? resolved.value : undefined;
		})();
		cache.set(candidatePath, pending);
	}
	return await pending;
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
	for (const [index, candidate] of candidates.entries()) candidate.evidence = graphRankingEvidence(candidate.candidate, index + 1);
	return {
		ranking: [...candidates],
		fallback: candidates.filter((candidate) => isGraphFallbackCandidate(candidate.candidate)),
	};
}

function emptyGraphCandidates(): GraphCandidates {
	return { ranking: [], fallback: [] };
}

function pathDepth(relativePath: string): number {
	return relativePath === "." ? 0 : relativePath.split("/").length;
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
