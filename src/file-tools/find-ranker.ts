import path from "node:path";
import Fuse, { type FuseResult } from "fuse.js";

import type { FindEntry } from "./types.js";

export interface RankedFindEntry {
	entry: FindEntry;
	score: number;
}

export interface RankedFindEntries {
	matches: RankedFindEntry[];
	suggestions: RankedFindEntry[];
}

interface QueryTokens {
	raw: string;
	normalized: string;
	tokens: string[];
	smartCase: boolean;
	testIntent: boolean;
}

interface FuseFindDocument {
	entry: FindEntry;
	searchPath: string;
	path: string;
	basename: string;
	stem: string;
	segments: string;
	tokens: string[];
}

const TEST_TOKENS = new Set(["test", "spec", "fixture", "fixtures", "mock", "mocks"]);
const FUSE_MATCH_THRESHOLD = 0.38;
const FUSE_SUGGESTION_THRESHOLD = 0.55;
const EXACT_PATH_SCORE = 100_000;
const EXACT_BASENAME_SCORE = 90_000;
const SMART_CASE_WORD_SCORE = 88_000;
const EXACT_STEM_SCORE = 86_000;
const EXACT_SEGMENT_SCORE = 82_000;
const BASENAME_PREFIX_SCORE = 72_000;
const BASENAME_CONTAINS_SCORE = 68_000;
const PATH_CONTAINS_SCORE = 58_000;

/** 构造路径条目；basename、segments 和 tokens 是 find 排序的唯一索引信息。 */
export function createFindEntry(workspacePath: string, kind: FindEntry["kind"]): FindEntry {
	const normalizedPath = normalizePath(workspacePath);
	const segments = normalizedPath === "." ? ["."] : normalizedPath.split("/");
	const basename = segments[segments.length - 1] ?? normalizedPath;
	const extension = kind === "file" ? extensionOf(basename) : undefined;
	const stem = extension === undefined ? basename : basename.slice(0, -extension.length - 1);
	const tokens = pathTokens(normalizedPath, basename, stem, segments);
	return {
		path: normalizedPath,
		kind,
		basename,
		stem,
		...(extension !== undefined ? { extension } : {}),
		segments,
		tokens,
		depth: normalizedPath === "." ? 0 : segments.length,
	};
}

/** fuzzy 查询由 Fuse.js 排序；exact/name/path 硬优先级仍由 find 保证。 */
export function rankFindEntries(entries: FindEntry[], query: string, rootPath: string): RankedFindEntries {
	const queryTokens = tokenizeQuery(query);
	const exact = rankExactEntries(entries, queryTokens, rootPath);
	if (exact.length > 0) {
		const exactPaths = new Set(exact.map((item) => item.entry.path));
		return {
			matches: exact,
			suggestions: rankFuse(entries.filter((entry) => !exactPaths.has(entry.path)), queryTokens, rootPath, FUSE_SUGGESTION_THRESHOLD).slice(0, 3),
		};
	}

	const strict = rankFuse(entries, queryTokens, rootPath, FUSE_MATCH_THRESHOLD)
		.filter((item) => tokenCoverage(queryTokens.tokens, item.entry.tokens) === queryTokens.tokens.length);
	if (strict.length > 0) return { matches: strict, suggestions: rankFuse(entries, queryTokens, rootPath, FUSE_SUGGESTION_THRESHOLD).slice(0, 3) };
	return { matches: [], suggestions: rankFuse(entries, queryTokens, rootPath, FUSE_SUGGESTION_THRESHOLD).slice(0, 3) };
}

/** Glob 结果仍统一评分；glob 符号只用于路由，排序主要看静态字面量和路径短度。 */
export function rankGlobEntries(entries: FindEntry[], query: string, rootPath: string): RankedFindEntry[] {
	const rankingQuery = query.replace(/[!*?[\]{}()+@|,]/gu, " ");
	const queryTokens = tokenizeQuery(rankingQuery);
	if (queryTokens.tokens.length === 0) {
		return entries.map((entry) => ({ entry, score: globFallbackScore(entry) })).sort(compareRankedEntries);
	}
	const exact = rankExactEntries(entries, queryTokens, rootPath);
	const exactPaths = new Set(exact.map((item) => item.entry.path));
	const fuzzy = entries
		.filter((entry) => !exactPaths.has(entry.path))
		.map((entry) => ({ entry, score: globFallbackScore(entry) + tokenCoverage(queryTokens.tokens, entry.tokens) * 1_000 }))
		.filter((item) => tokenCoverage(queryTokens.tokens, item.entry.tokens) > 0);
	return [...exact, ...fuzzy].sort(compareRankedEntries);
}

function rankExactEntries(entries: FindEntry[], query: QueryTokens, rootPath: string): RankedFindEntry[] {
	return entries
		.map((entry) => {
			const score = exactScore(entry, query, rootPath);
			return score === 0 ? undefined : { entry, score };
		})
		.filter((item): item is RankedFindEntry => item !== undefined)
		.sort(compareRankedEntries);
}

function exactScore(entry: FindEntry, query: QueryTokens, rootPath: string): number {
	const searchPath = searchRelativePath(rootPath, entry.path);
	const normalizedPath = normalizeToken(searchPath);
	const basename = normalizeToken(entry.basename);
	const stem = normalizeToken(entry.stem);
	const segments = entry.segments.map(normalizeToken);
	const exactCaseBonus = query.smartCase ? smartCaseBonus(entry, query.raw, searchPath) : 0;

	if (normalizedPath === query.normalized) return EXACT_PATH_SCORE + exactCaseBonus - entry.depth;
	if (basename === query.normalized) return EXACT_BASENAME_SCORE + kindBonus(entry) + exactCaseBonus - entry.depth;
	if (query.smartCase && (entry.basename.startsWith(query.raw) || entry.stem.startsWith(query.raw))) {
		return SMART_CASE_WORD_SCORE + kindBonus(entry) + exactCaseBonus - entry.depth;
	}
	if (stem === query.normalized) return EXACT_STEM_SCORE + kindBonus(entry) + exactCaseBonus - entry.depth;
	if (segments.includes(query.normalized)) return EXACT_SEGMENT_SCORE + kindBonus(entry) + exactCaseBonus - entry.depth;
	if (basename.startsWith(query.normalized)) return BASENAME_PREFIX_SCORE + query.normalized.length * 10 + exactCaseBonus - entry.depth;
	if (basename.includes(query.normalized)) return BASENAME_CONTAINS_SCORE + query.normalized.length * 8 + exactCaseBonus - entry.depth;
	if (normalizedPath.includes(query.normalized)) return PATH_CONTAINS_SCORE + query.normalized.length * 4 + exactCaseBonus - entry.depth;
	return 0;
}

function rankFuse(entries: FindEntry[], query: QueryTokens, rootPath: string, maxScore: number): RankedFindEntry[] {
	if (entries.length === 0) return [];
	const documents = entries.map((entry) => toFuseDocument(entry, rootPath));
	const fuse = new Fuse(documents, {
		includeScore: true,
		ignoreLocation: true,
		ignoreFieldNorm: true,
		threshold: maxScore,
		useTokenSearch: query.tokens.length > 1,
		tokenMatch: "all",
		tokenize: splitWords,
		keys: [
			{ name: "basename", weight: 0.45 },
			{ name: "stem", weight: 0.35 },
			{ name: "segments", weight: 0.25 },
			{ name: "tokens", weight: 0.2 },
			{ name: "searchPath", weight: 0.15 },
			{ name: "path", weight: 0.1 },
		],
	});
	return fuse.search(query.raw)
		.filter((result) => (result.score ?? 1) <= maxScore)
		.map((result) => rankedFromFuse(result, query))
		.sort(compareRankedEntries);
}

function rankedFromFuse(result: FuseResult<FuseFindDocument>, query: QueryTokens): RankedFindEntry {
	const entry = result.item.entry;
	const fuseScore = result.score ?? 1;
	let score = 50_000 - fuseScore * 20_000;
	score += tokenCoverage(query.tokens, entry.tokens) * 750;
	score += exactTokenCoverage(query.tokens, entry.tokens) * 2_000;
	if (query.testIntent && hasTestPath(entry)) score += 2_000;
	if (query.smartCase) score += smartCaseBonus(entry, query.raw, result.item.searchPath);
	score += kindBonus(entry);
	score -= entry.depth * 5;
	score -= entry.path.length / 100;
	return { entry, score };
}

function globFallbackScore(entry: FindEntry): number {
	return 10_000 - entry.path.length * 10 - entry.depth;
}

function toFuseDocument(entry: FindEntry, rootPath: string): FuseFindDocument {
	return {
		entry,
		searchPath: searchRelativePath(rootPath, entry.path),
		path: entry.path,
		basename: entry.basename,
		stem: entry.stem,
		segments: entry.segments.join(" "),
		tokens: entry.tokens,
	};
}

function tokenCoverage(queryTokens: string[], entryTokens: string[]): number {
	let covered = 0;
	for (const token of queryTokens) {
		if (tokenIndex(entryTokens, token) !== -1) covered += 1;
	}
	return covered;
}

function exactTokenCoverage(queryTokens: string[], entryTokens: string[]): number {
	let covered = 0;
	for (const token of queryTokens) {
		if (entryTokens.includes(token)) covered += 1;
	}
	return covered;
}

function tokenIndex(entryTokens: string[], queryToken: string): number {
	const exact = entryTokens.indexOf(queryToken);
	if (exact !== -1) return exact;
	if (queryToken.length <= 1) return -1;
	return entryTokens.findIndex((token) => token.startsWith(queryToken) || token.includes(queryToken));
}

function smartCaseBonus(entry: FindEntry, rawQuery: string, searchPath: string): number {
	if (searchPath === rawQuery) return 1_500;
	if (entry.basename === rawQuery) return 1_200;
	if (entry.stem === rawQuery) return 1_000;
	if (entry.segments.includes(rawQuery)) return 800;
	return searchPath.includes(rawQuery) ? 300 : 0;
}

function kindBonus(entry: FindEntry): number {
	return entry.kind === "directory" ? 500 : 0;
}

function hasTestPath(entry: FindEntry): boolean {
	return entry.tokens.some((token) => TEST_TOKENS.has(token));
}

function tokenizeQuery(query: string): QueryTokens {
	const normalized = normalizeToken(query);
	const tokens = unique(splitWords(query).map(normalizeToken).filter((token) => token.length > 0 && token !== "."));
	return {
		raw: query,
		normalized,
		tokens,
		smartCase: /[A-Z]/u.test(query),
		testIntent: tokens.some((token) => TEST_TOKENS.has(token)),
	};
}

function pathTokens(normalizedPath: string, basename: string, stem: string, segments: string[]): string[] {
	const parts = [normalizedPath, basename, stem, ...segments];
	for (const segment of segments) parts.push(...splitWords(segment));
	return unique(parts.map(normalizeToken).filter((token) => token.length > 0));
}

function splitWords(value: string): string[] {
	return value
		.replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
		.replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
		.replace(/([A-Za-z])([0-9])/gu, "$1 $2")
		.replace(/([0-9])([A-Za-z])/gu, "$1 $2")
		.split(/[\\/\s._-]+/u)
		.filter((part) => part.length > 0);
}

function extensionOf(basename: string): string | undefined {
	const extension = path.extname(basename);
	if (extension.length <= 1) return undefined;
	return extension.slice(1);
}

function searchRelativePath(rootPath: string, workspacePath: string): string {
	if (rootPath === ".") return workspacePath;
	if (workspacePath === rootPath) return ".";
	if (workspacePath.startsWith(`${rootPath}/`)) return workspacePath.slice(rootPath.length + 1);
	return workspacePath;
}

function normalizePath(value: string): string {
	const normalized = value.replace(/\\/gu, "/").replace(/^\.\/+/u, "").replace(/\/+/gu, "/").replace(/\/$/u, "");
	return normalized.length === 0 ? "." : normalized;
}

function normalizeToken(value: string): string {
	return value.replace(/\\/gu, "/").toLowerCase();
}

function unique(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

function compareRankedEntries(left: RankedFindEntry, right: RankedFindEntry): number {
	const score = right.score - left.score;
	if (score !== 0) return score;
	const length = left.entry.path.length - right.entry.path.length;
	if (length !== 0) return length;
	const depth = left.entry.depth - right.entry.depth;
	if (depth !== 0) return depth;
	return compareStableString(left.entry.path, right.entry.path);
}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
