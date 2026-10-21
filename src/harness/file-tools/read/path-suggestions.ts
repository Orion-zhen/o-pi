import type { DirectoryRef, FileRef } from "../../filesystem/contracts/path.ts";
import { fsFailure, fsSuccess, type FsResult } from "../../filesystem/contracts/result.ts";
import type { DiscoveryOperations } from "../../filesystem/contracts/discovery.ts";

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
		editSimilarity(queryBase, candidateBase, 0.42),
		editSimilarity(queryPath, candidatePath, 0.42 / 0.9) * 0.9,
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

function editSimilarity(left: string, right: string, minimum: number): number {
	if (left === right) return 1;
	const length = Math.max(left.length, right.length);
	const budget = Math.ceil((1 - minimum) * length);
	if (Math.abs(left.length - right.length) > budget) return 0;
	let start = 0;
	while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
	let leftEnd = left.length;
	let rightEnd = right.length;
	while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) { leftEnd -= 1; rightEnd -= 1; }
	left = left.slice(start, leftEnd);
	right = right.slice(start, rightEnd);
	if (right.length > left.length) [left, right] = [right, left];
	if (right.length === 0) return 1 - left.length / length;

	// 只计算仍可能达到建议阈值的对角带，两行数组反复复用。
	const unreachable = budget + 1;
	let previous = Uint32Array.from({ length: right.length + 1 }, (_, index) => Math.min(index, unreachable));
	let current = new Uint32Array(right.length + 1).fill(unreachable);
	for (let row = 1; row <= left.length; row += 1) {
		const low = Math.max(1, row - budget);
		const high = Math.min(right.length, row + budget);
		current[0] = row;
		if (low > 1) current[low - 1] = unreachable;
		if (high < right.length) current[high + 1] = unreachable;
		let best = unreachable;
		for (let column = low; column <= high; column += 1) {
			const distance = Math.min((previous[column] as number) + 1, (current[column - 1] as number) + 1,
				(previous[column - 1] as number) + Number(left[row - 1] !== right[column - 1]));
			current[column] = distance;
			best = Math.min(best, distance);
		}
		if (best > budget) return 0;
		[previous, current] = [current, previous];
	}
	return 1 - (previous[right.length] as number) / length;
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
