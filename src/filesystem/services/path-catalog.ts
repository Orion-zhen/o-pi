import type {
	PathCatalogCandidate,
	PathCatalogOperations,
	PathCatalogOptions,
} from "../contracts/catalog.js";
import type { DirectoryRef } from "../contracts/path.js";
import { fsFailure, fsSuccess, type FsOperationContext, type FsResult } from "../contracts/result.js";
import type { TraversalOperations } from "../contracts/traversal.js";
import { compareLogicalPath } from "./path-order.js";

const MINIMUM_SIMILARITY = 0.42;

/** Lightweight typo-oriented path suggestions over policy-filtered traversal. */
export class WorkspacePathCatalog implements PathCatalogOperations {
	constructor(private readonly traversal: TraversalOperations) {}

	async suggest(
		root: DirectoryRef,
		query: string,
		options: PathCatalogOptions,
		context: FsOperationContext,
	): Promise<FsResult<readonly PathCatalogCandidate[]>> {
		if (!Number.isSafeInteger(options.limit) || options.limit < 0
			|| !Number.isSafeInteger(options.maxEntries) || options.maxEntries < 0) {
			return fsFailure({ code: "invalid-path", message: "Catalog limits must be non-negative integers.", path: root.displayPath });
		}
		if (options.limit === 0 || normalizePath(query) === "") return fsSuccess([]);
		const walked = await this.traversal.walk(root, {
			intent: "search",
			explicitRoot: true,
			maxEntries: options.maxEntries,
		}, context);
		if (!walked.ok) return walked;

		const kinds = new Set(options.kinds ?? ["file"]);
		const candidates: PathCatalogCandidate[] = [];
		for await (const event of walked.value) {
			if (event.type === "error") {
				if (event.error.code === "aborted") return fsFailure(event.error);
				continue;
			}
			if (event.type !== "entry" || !kinds.has(event.ref.kind)) continue;
			const similarity = pathNameSimilarity(query, event.ref.workspacePath ?? event.ref.displayPath);
			if (similarity >= MINIMUM_SIMILARITY) candidates.push({ ref: event.ref, similarity });
		}
		return fsSuccess(candidates
			.sort((left, right) => right.similarity - left.similarity
				|| compareLogicalPath(left.ref.displayPath, right.ref.displayPath))
			.slice(0, options.limit));
	}
}

export function pathNameSimilarity(query: string, candidate: string): number {
	const queryPath = normalizePath(query);
	const candidatePath = normalizePath(candidate);
	if (queryPath === "" || candidatePath === "") return 0;
	if (queryPath === candidatePath) return 1;
	const queryBase = basename(queryPath);
	const candidateBase = basename(candidatePath);
	if (queryBase === candidateBase) return 0.98;
	if (candidateBase.startsWith(queryBase) || queryBase.startsWith(candidateBase)) return 0.9;
	if (candidateBase.includes(queryBase) || queryBase.includes(candidateBase)) return 0.86;

	const basenameEdit = editSimilarity(queryBase, candidateBase);
	const pathEdit = editSimilarity(queryPath, candidatePath) * 0.9;
	const basenameBigrams = diceSimilarity(queryBase, candidateBase) * 0.88;
	return Math.max(basenameEdit, pathEdit, basenameBigrams);
}

function normalizePath(value: string): string {
	return value.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/{2,}/gu, "/").toLowerCase();
}

function basename(value: string): string {
	return value.slice(value.lastIndexOf("/") + 1);
}

function editSimilarity(left: string, right: string): number {
	if (left === right) return 1;
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		const current = [leftIndex];
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			const substitution = previous[rightIndex - 1] ?? 0;
			const deletion = previous[rightIndex] ?? 0;
			const insertion = current[rightIndex - 1] ?? 0;
			current.push(Math.min(
				deletion + 1,
				insertion + 1,
				substitution + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			));
		}
		previous = current;
	}
	return 1 - (previous[right.length] ?? Math.max(left.length, right.length)) / Math.max(left.length, right.length);
}

function diceSimilarity(left: string, right: string): number {
	if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
	const counts = new Map<string, number>();
	for (let index = 0; index < left.length - 1; index += 1) {
		const pair = left.slice(index, index + 2);
		counts.set(pair, (counts.get(pair) ?? 0) + 1);
	}
	let intersection = 0;
	for (let index = 0; index < right.length - 1; index += 1) {
		const pair = right.slice(index, index + 2);
		const count = counts.get(pair) ?? 0;
		if (count === 0) continue;
		intersection += 1;
		counts.set(pair, count - 1);
	}
	return (2 * intersection) / (left.length + right.length - 2);
}
