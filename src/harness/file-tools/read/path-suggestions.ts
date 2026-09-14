import type { DirectoryRef, FileRef } from "../../filesystem/contracts/path.js";
import { fsFailure, fsSuccess, type FsResult } from "../../filesystem/contracts/result.js";
import type { DiscoveryOperations } from "../../filesystem/contracts/discovery.js";

interface PathSuggestion {
	readonly ref: FileRef;
	readonly similarity: number;
}

/** 文件系统只提供候选事实，read 自己决定拼写建议和排名。 */
export async function suggestPaths(
	discovery: DiscoveryOperations,
	root: DirectoryRef,
	query: string,
	options: { readonly limit: number; readonly maxEntries: number },
): Promise<FsResult<readonly PathSuggestion[]>> {
	if (options.limit === 0 || normalizePath(query) === "") return fsSuccess([]);
	const opened = await discovery.discover(root, { maxEntries: options.maxEntries });
	if (!opened.ok) return opened;
	const candidates: PathSuggestion[] = [];
	for await (const event of opened.value) {
		if (event.type === "error") {
			if (event.error.code === "aborted") return fsFailure(event.error);
			continue;
		}
		if (event.type !== "entry" || event.ref.kind !== "file") continue;
		const similarity = pathNameSimilarity(query, event.ref.workspacePath ?? event.ref.displayPath);
		if (similarity >= 0.42) candidates.push({ ref: event.ref, similarity });
	}
	return fsSuccess(candidates.sort((left, right) => right.similarity - left.similarity
		|| comparePath(left.ref.displayPath, right.ref.displayPath)).slice(0, options.limit));
}

function pathNameSimilarity(query: string, candidate: string): number {
	const queryPath = normalizePath(query);
	const candidatePath = normalizePath(candidate);
	if (queryPath === "" || candidatePath === "") return 0;
	if (queryPath === candidatePath) return 1;
	const queryBase = basename(queryPath);
	const candidateBase = basename(candidatePath);
	if (queryBase === candidateBase) return 0.98;
	if (candidateBase.startsWith(queryBase) || queryBase.startsWith(candidateBase)) return 0.9;
	if (candidateBase.includes(queryBase) || queryBase.includes(candidateBase)) return 0.86;
	return Math.max(
		editSimilarity(queryBase, candidateBase),
		editSimilarity(queryPath, candidatePath) * 0.9,
		diceSimilarity(queryBase, candidateBase) * 0.88,
	);
}

function normalizePath(value: string): string {
	return value.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/{2,}/gu, "/").toLowerCase();
}

function basename(value: string): string {
	return value.slice(value.lastIndexOf("/") + 1);
}

function comparePath(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
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
			current.push(Math.min(deletion + 1, insertion + 1,
				substitution + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)));
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
