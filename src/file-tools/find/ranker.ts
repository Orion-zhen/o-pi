import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import type { FindEntry } from "./types.js";
import type { FindQueryPlan, FindQueryTerm } from "./query.js";

export interface RankedFindEntry {
	readonly entry: FindEntry;
	readonly score: number;
	readonly positions: readonly number[];
	readonly basenameMatches: number;
	readonly span: number;
}

interface TermMatch {
	readonly matched: boolean;
	readonly score: number;
	readonly positions: readonly number[];
}

interface SearchText {
	readonly original: readonly string[];
	readonly folded: readonly string[];
	readonly sensitive: readonly string[];
	readonly bonuses: readonly number[];
}

interface CompiledFindQueryTerm extends FindQueryTerm {
	readonly pattern: readonly string[];
}

interface CompiledFindQueryPlan {
	/** 外层为 AND，内层为 OR。 */
	readonly groups: readonly (readonly CompiledFindQueryTerm[])[];
	readonly needsFoldedText: boolean;
}

export interface LimitedFindRanking {
	readonly ranked: RankedFindEntry[];
	readonly totalMatches: number;
}

const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;
const BONUS_BOUNDARY = 8;
const BONUS_DELIMITER = 9;
const BONUS_CAMEL_123 = 7;
const BONUS_CONSECUTIVE = 4;
const BONUS_FIRST_MULTIPLIER = 2;
const NEGATIVE_INFINITY = Number.NEGATIVE_INFINITY;
const RANKING_YIELD_INTERVAL = 256;

/** 固定使用 path scheme 的 fzf-v2 风格排名，不接受模型侧 ranking flags。 */
export function rankFindEntries(entries: readonly FindEntry[], plan: FindQueryPlan): RankedFindEntry[] {
	const compiled = compileFindQueryPlan(plan);
	const ranked: RankedFindEntry[] = [];
	for (const entry of entries) {
		const candidate = rankEntry(entry, compiled);
		if (candidate !== undefined) ranked.push(candidate);
	}
	return ranked.sort(compareRankedEntries);
}

/** runtime 排名分批让出事件循环；undefined 表示 signal 已取消。 */
export async function rankFindEntriesAsync(
	entries: readonly FindEntry[],
	plan: FindQueryPlan,
	signal?: AbortSignal,
): Promise<RankedFindEntry[] | undefined> {
	const compiled = compileFindQueryPlan(plan);
	const ranked: RankedFindEntry[] = [];
	for (const [index, entry] of entries.entries()) {
		if (isAborted(signal)) return undefined;
		if (index > 0 && index % RANKING_YIELD_INTERVAL === 0) {
			await yieldToEventLoop();
			if (isAborted(signal)) return undefined;
		}
		const candidate = rankEntry(entry, compiled);
		if (candidate !== undefined) ranked.push(candidate);
	}
	if (isAborted(signal)) return undefined;
	return ranked.sort(compareRankedEntries);
}

/** 统计全部命中，但只保留 relevance 前缀，避免为 result limit 之外的命中执行全量排序。 */
export async function rankFindEntriesLimitedAsync(
	entries: readonly FindEntry[],
	plan: FindQueryPlan,
	limit: number,
	signal?: AbortSignal,
): Promise<LimitedFindRanking | undefined> {
	if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("find ranking limit must be a non-negative integer.");
	const compiled = compileFindQueryPlan(plan);
	const ranked: RankedFindEntry[] = [];
	let totalMatches = 0;
	for (const [index, entry] of entries.entries()) {
		if (isAborted(signal)) return undefined;
		if (index > 0 && index % RANKING_YIELD_INTERVAL === 0) {
			await yieldToEventLoop();
			if (isAborted(signal)) return undefined;
		}
		const candidate = rankEntry(entry, compiled);
		if (candidate === undefined) continue;
		totalMatches += 1;
		insertRankedPrefix(ranked, candidate, limit);
	}
	if (isAborted(signal)) return undefined;
	return { ranked, totalMatches };
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function rankEntry(entry: FindEntry, plan: CompiledFindQueryPlan): RankedFindEntry | undefined {
	const search = prepareSearchText(entry.searchPath, plan.needsFoldedText);
	let score = 0;
	const positions = new Set<number>();
	for (const alternatives of plan.groups) {
		let best: TermMatch | undefined;
		for (const term of alternatives) {
			const candidate = matchTerm(search, term);
			if (!candidate.matched) continue;
			if (best === undefined || compareTermMatches(candidate, best) < 0) best = candidate;
		}
		if (best === undefined) return undefined;
		score += best.score;
		for (const position of best.positions) positions.add(position);
	}
	const sortedPositions = [...positions].sort((left, right) => left - right);
	const basenameStart = basenameOffset(search.original);
	return {
		entry,
		score,
		positions: sortedPositions,
		basenameMatches: sortedPositions.filter((position) => position >= basenameStart).length,
		span: matchSpan(sortedPositions),
	};
}

function matchTerm(search: SearchText, term: CompiledFindQueryTerm): TermMatch {
	const text = term.caseSensitive ? search.sensitive : search.folded;
	const positive = term.type === "fuzzy"
		? fuzzyMatch(search, text, term.pattern)
		: exactMatch(search, text, term.pattern, term.type);
	if (!term.inverse) return positive;
	return positive.matched
		? { matched: false, score: 0, positions: [] }
		: { matched: true, score: 0, positions: [] };
}

function fuzzyMatch(search: SearchText, text: readonly string[], pattern: readonly string[]): TermMatch {
	if (pattern.length === 0 || pattern.length > text.length || !isSubsequence(text, pattern)) {
		return { matched: false, score: 0, positions: [] };
	}
	const scores = Array.from({ length: pattern.length }, () => new Array<number>(text.length).fill(NEGATIVE_INFINITY));
	const previous = Array.from({ length: pattern.length }, () => new Array<number>(text.length).fill(-1));
	const runBonuses = Array.from({ length: pattern.length }, () => new Array<number>(text.length).fill(0));
	const firstScores = scores[0];
	const firstRunBonuses = runBonuses[0];
	if (firstScores === undefined || firstRunBonuses === undefined) {
		return { matched: false, score: 0, positions: [] };
	}

	for (let column = 0; column < text.length; column += 1) {
		if (text[column] !== pattern[0]) continue;
		const boundary = search.bonuses[column] ?? 0;
		firstScores[column] = SCORE_MATCH + boundary * BONUS_FIRST_MULTIPLIER;
		firstRunBonuses[column] = boundary;
	}

	for (let row = 1; row < pattern.length; row += 1) {
		const priorScores = scores[row - 1];
		const currentScores = scores[row];
		const priorRunBonuses = runBonuses[row - 1];
		const currentRunBonuses = runBonuses[row];
		const currentPrevious = previous[row];
		if (
			priorScores === undefined
			|| currentScores === undefined
			|| priorRunBonuses === undefined
			|| currentRunBonuses === undefined
			|| currentPrevious === undefined
		) return { matched: false, score: 0, positions: [] };
		let bestGapValue = NEGATIVE_INFINITY;
		let bestGapColumn = -1;
		for (let column = 0; column < text.length; column += 1) {
			const eligible = column - 2;
			if (eligible >= 0) {
				const prior = priorScores[eligible] ?? NEGATIVE_INFINITY;
				const value = prior - eligible * SCORE_GAP_EXTENSION;
				if (value > bestGapValue) {
					bestGapValue = value;
					bestGapColumn = eligible;
				}
			}
			if (text[column] !== pattern[row]) continue;

			const boundary = search.bonuses[column] ?? 0;
			let bestScore = NEGATIVE_INFINITY;
			let predecessor = -1;
			let runBonus = boundary;
			const consecutiveScore = column > 0
				? priorScores[column - 1] ?? NEGATIVE_INFINITY
				: NEGATIVE_INFINITY;
			if (Number.isFinite(consecutiveScore)) {
				const priorRunBonus = priorRunBonuses[column - 1] ?? 0;
				const consecutiveBonus = Math.max(BONUS_CONSECUTIVE, boundary, priorRunBonus);
				bestScore = consecutiveScore + SCORE_MATCH + consecutiveBonus;
				predecessor = column - 1;
				runBonus = priorRunBonus === 0 ? boundary : priorRunBonus;
			}
			if (bestGapColumn >= 0) {
				const gapScore = bestGapValue
					+ SCORE_GAP_START
					+ (column - 2) * SCORE_GAP_EXTENSION
					+ SCORE_MATCH
					+ boundary;
				if (gapScore > bestScore) {
					bestScore = gapScore;
					predecessor = bestGapColumn;
					runBonus = boundary;
				}
			}
			currentScores[column] = bestScore;
			currentPrevious[column] = predecessor;
			currentRunBonuses[column] = runBonus;
		}
	}

	const finalRow = scores[pattern.length - 1];
	if (finalRow === undefined) return { matched: false, score: 0, positions: [] };
	let end = -1;
	let score = NEGATIVE_INFINITY;
	for (let column = 0; column < finalRow.length; column += 1) {
		const candidate = finalRow[column] ?? NEGATIVE_INFINITY;
		if (candidate > score) {
			score = candidate;
			end = column;
		}
	}
	if (end < 0 || !Number.isFinite(score)) return { matched: false, score: 0, positions: [] };
	const positions = new Array<number>(pattern.length);
	let column = end;
	for (let row = pattern.length - 1; row >= 0; row -= 1) {
		positions[row] = column;
		column = previous[row]?.[column] ?? -1;
	}
	return { matched: true, score, positions };
}

function exactMatch(
	search: SearchText,
	text: readonly string[],
	pattern: readonly string[],
	type: Exclude<FindQueryTerm["type"], "fuzzy">,
): TermMatch {
	if (pattern.length === 0 || pattern.length > text.length) return { matched: false, score: 0, positions: [] };
	const starts: number[] = [];
	if (type === "prefix" || type === "equal") starts.push(0);
	else if (type === "suffix") starts.push(text.length - pattern.length);
	else {
		for (let start = 0; start <= text.length - pattern.length; start += 1) starts.push(start);
	}
	let best: TermMatch | undefined;
	for (const start of starts) {
		if (type === "equal" && pattern.length !== text.length) continue;
		if (!sameSlice(text, pattern, start)) continue;
		const end = start + pattern.length;
		if (type === "boundary" && !isBoundaryMatch(search.original, start, end)) continue;
		const positions = Array.from({ length: pattern.length }, (_value, index) => start + index);
		const score = contiguousScore(search.bonuses, positions);
		const candidate = { matched: true, score, positions } satisfies TermMatch;
		if (best === undefined || compareTermMatches(candidate, best) < 0) best = candidate;
	}
	return best ?? { matched: false, score: 0, positions: [] };
}

function contiguousScore(bonuses: readonly number[], positions: readonly number[]): number {
	let score = 0;
	let firstBonus = 0;
	for (const [index, position] of positions.entries()) {
		const boundary = bonuses[position] ?? 0;
		if (index === 0) {
			firstBonus = boundary;
			score += SCORE_MATCH + boundary * BONUS_FIRST_MULTIPLIER;
		} else {
			score += SCORE_MATCH + Math.max(BONUS_CONSECUTIVE, boundary, firstBonus);
		}
	}
	return score;
}

function compileFindQueryPlan(plan: FindQueryPlan): CompiledFindQueryPlan {
	return {
		groups: plan.groups.map((alternatives) => alternatives.map((term) => ({
			...term,
			pattern: normalizeChars(term.text, term.caseSensitive),
		}))),
		needsFoldedText: plan.groups.some((alternatives) => alternatives.some((term) => !term.caseSensitive)),
	};
}

function prepareSearchText(value: string, needsFoldedText: boolean): SearchText {
	const original = Array.from(value);
	const sensitive = original.map(normalizeSensitiveChar);
	return {
		original,
		folded: needsFoldedText ? sensitive.map((char) => char.toLocaleLowerCase()) : sensitive,
		sensitive,
		bonuses: original.map((char, index) => bonusFor(original[index - 1], char, index)),
	};
}

function normalizeChars(value: string, caseSensitive: boolean): string[] {
	const normalized = Array.from(value).map(normalizeSensitiveChar);
	return caseSensitive ? normalized : normalized.map((char) => char.toLocaleLowerCase());
}

function normalizeSensitiveChar(value: string): string {
	return value.normalize("NFD").replace(/\p{M}/gu, "");
}

function bonusFor(previous: string | undefined, current: string, index: number): number {
	if (index === 0 || previous === undefined || previous === "/") return BONUS_DELIMITER;
	if (isBoundary(previous, current)) return BONUS_BOUNDARY;
	if (isLower(previous) && isUpper(current) || !isNumber(previous) && isNumber(current)) return BONUS_CAMEL_123;
	return 0;
}

function isBoundary(previous: string, current: string): boolean {
	return !isWord(previous) && isWord(current);
}

function isBoundaryMatch(text: readonly string[], start: number, end: number): boolean {
	const before = text[start - 1];
	const after = text[end];
	return (before === undefined || !isWord(before)) && (after === undefined || !isWord(after));
}

function isWord(value: string): boolean {
	return /[\p{L}\p{N}]/u.test(value);
}

function isLower(value: string): boolean {
	return /\p{Ll}/u.test(value);
}

function isUpper(value: string): boolean {
	return /\p{Lu}/u.test(value);
}

function isNumber(value: string): boolean {
	return /\p{N}/u.test(value);
}

function isSubsequence(text: readonly string[], pattern: readonly string[]): boolean {
	let patternIndex = 0;
	for (const char of text) {
		if (char === pattern[patternIndex]) patternIndex += 1;
		if (patternIndex === pattern.length) return true;
	}
	return false;
}

function sameSlice(text: readonly string[], pattern: readonly string[], start: number): boolean {
	return pattern.every((char, index) => text[start + index] === char);
}

function compareTermMatches(left: TermMatch, right: TermMatch): number {
	return right.score - left.score
		|| matchSpan(left.positions) - matchSpan(right.positions)
		|| (left.positions[0] ?? Number.MAX_SAFE_INTEGER) - (right.positions[0] ?? Number.MAX_SAFE_INTEGER);
}

function compareRankedEntries(left: RankedFindEntry, right: RankedFindEntry): number {
	return right.score - left.score
		|| right.basenameMatches - left.basenameMatches
		|| left.span - right.span
		|| left.entry.searchPath.length - right.entry.searchPath.length
		|| left.entry.scopeOrder - right.entry.scopeOrder
		|| compareStableString(left.entry.path, right.entry.path);
}

function insertRankedPrefix(
	ranked: RankedFindEntry[],
	candidate: RankedFindEntry,
	limit: number,
): void {
	if (limit === 0) return;
	let low = 0;
	let high = ranked.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		const current = ranked[middle];
		if (current !== undefined && compareRankedEntries(candidate, current) < 0) high = middle;
		else low = middle + 1;
	}
	if (low >= limit) return;
	ranked.splice(low, 0, candidate);
	if (ranked.length > limit) ranked.pop();
}

function basenameOffset(chars: readonly string[]): number {
	for (let index = chars.length - 1; index >= 0; index -= 1) {
		if (chars[index] === "/") return index + 1;
	}
	return 0;
}

function matchSpan(positions: readonly number[]): number {
	if (positions.length === 0) return 0;
	return (positions[positions.length - 1] ?? 0) - (positions[0] ?? 0) + 1;
}

function compareStableString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
