import path from "node:path";
import Fuse, { type FuseResult } from "fuse.js";

import { createSourceRankingEvidence, EMPTY_RANKING_EVIDENCE, type RankingEvidence } from "../ranking-evidence.js";
import type { FindEntry } from "../types.js";

export interface RankedFindEntry {
	entry: FindEntry;
	tier: number;
	evidence: RankingEvidence;
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

interface ExactRankedEntry extends RankedFindEntry {
	caseExact: boolean;
}

interface FuseRankedEntry extends RankedFindEntry {
	matchScore: number;
	coveredTokens: number;
	exactTokens: number;
	testMatch: boolean;
	caseMatch: boolean;
}

const TEST_TOKENS = new Set(["test", "spec", "fixture", "fixtures", "mock", "mocks"]);
const FUSE_MATCH_THRESHOLD = 0.38;
const FUSE_SUGGESTION_THRESHOLD = 0.55;

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
	const matches = rankFindMatches(entries, query, rootPath);
	return {
		matches,
		suggestions: matches.length === 0 ? rankFindSuggestions(entries, query, rootPath) : [],
	};
}

/** Glob 结果按路径稳定排序，不把模式符号送入 fuzzy 排名。 */
export function rankGlobEntries(entries: FindEntry[]): RankedFindEntry[] {
	return [...entries]
		.sort((left, right) => compareStableString(left.path, right.path))
		.map((entry, index) => ({
			entry,
			tier: 3,
			evidence: createSourceRankingEvidence("path", index + 1),
		}));
}

/** 主结果阶段不计算仅在零结果时可见的 typo suggestions。 */
export function rankFindMatches(entries: FindEntry[], query: string, rootPath: string): RankedFindEntry[] {
	const queryTokens = tokenizeQuery(query);
	const exact = rankExactEntries(entries, queryTokens, rootPath);
	if (exact.length > 0) return exact;

	const fuzzy = rankFuse(entries.filter((entry) => hasFullTokenCoverage(queryTokens.tokens, entry.tokens)), queryTokens, rootPath);
	return fuzzy
		.filter((item) => item.matchScore <= FUSE_MATCH_THRESHOLD && tokenCoverage(queryTokens.tokens, item.entry.tokens) === queryTokens.tokens.length)
		.map(withoutMatchScore);
}

/** Zero-result fallback only; each document's Fuse score is independent of collection membership. */
export function rankFindSuggestions(entries: FindEntry[], query: string, rootPath: string): RankedFindEntry[] {
	return rankFuse(entries, tokenizeQuery(query), rootPath).slice(0, 3).map(withoutMatchScore);
}

function rankExactEntries(entries: FindEntry[], query: QueryTokens, rootPath: string): RankedFindEntry[] {
	const ranked = entries
		.map((entry): ExactRankedEntry | undefined => {
			const baseTier = exactTier(entry, query, rootPath);
			if (baseTier === undefined) return undefined;
			const caseExact = smartCaseMatch(entry, query.raw, searchRelativePath(rootPath, entry.path));
			return {
				entry,
				tier: query.smartCase && !caseExact ? Math.min(3, baseTier + 1) : baseTier,
				evidence: EMPTY_RANKING_EVIDENCE,
				caseExact,
			};
		})
		.filter((item): item is ExactRankedEntry => item !== undefined)
		.sort(compareExactEntries);
	return withPathEvidence(ranked);
}

function exactTier(entry: FindEntry, query: QueryTokens, rootPath: string): number | undefined {
	const searchPath = searchRelativePath(rootPath, entry.path);
	const normalizedPath = normalizeToken(searchPath);
	const basename = normalizeToken(entry.basename);
	const stem = normalizeToken(entry.stem);
	const segments = entry.segments.map(normalizeToken);
	if (normalizedPath === query.normalized) return 0;
	if (basename === query.normalized || stem === query.normalized) return 1;
	if (segments.includes(query.normalized) || basename.startsWith(query.normalized)) return 2;
	if (basename.includes(query.normalized) || normalizedPath.includes(query.normalized)) return 3;
	return undefined;
}

function rankFuse(entries: FindEntry[], query: QueryTokens, rootPath: string): FuseRankedEntry[] {
	if (entries.length === 0) return [];
	const documents = entries.map((entry) => toFuseDocument(entry, rootPath));
	const fuse = new Fuse(documents, {
		includeScore: true,
		ignoreLocation: true,
		ignoreFieldNorm: true,
		threshold: FUSE_SUGGESTION_THRESHOLD,
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
	const ranked = fuse.search(query.raw)
		.filter((result) => (result.score ?? 1) <= FUSE_SUGGESTION_THRESHOLD)
		.map((result) => rankedFromFuse(result, query))
		.sort(compareFuseEntries);
	return withPathEvidence(ranked);
}

function rankedFromFuse(result: FuseResult<FuseFindDocument>, query: QueryTokens): FuseRankedEntry {
	const entry = result.item.entry;
	const fuseScore = result.score ?? 1;
	return {
		entry,
		tier: hasTestPath(entry) && !query.testIntent && !query.smartCase ? 5 : 4,
		evidence: EMPTY_RANKING_EVIDENCE,
		matchScore: fuseScore,
		coveredTokens: tokenCoverage(query.tokens, entry.tokens),
		exactTokens: exactTokenCoverage(query.tokens, entry.tokens),
		testMatch: query.testIntent && hasTestPath(entry),
		caseMatch: query.smartCase && smartCaseMatch(entry, query.raw, result.item.searchPath),
	};
}

function withoutMatchScore({ entry, tier, evidence }: FuseRankedEntry): RankedFindEntry {
	return { entry, tier, evidence };
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

function hasFullTokenCoverage(queryTokens: string[], entryTokens: string[]): boolean {
	return queryTokens.length > 0 && tokenCoverage(queryTokens, entryTokens) === queryTokens.length;
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

function smartCaseMatch(entry: FindEntry, rawQuery: string, searchPath: string): boolean {
	return searchPath === rawQuery
		|| entry.basename === rawQuery
		|| entry.stem === rawQuery
		|| entry.segments.includes(rawQuery)
		|| searchPath.includes(rawQuery);
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

function withPathEvidence<T extends RankedFindEntry>(ranked: T[]): T[] {
	for (const [index, item] of ranked.entries()) {
		item.evidence = createSourceRankingEvidence("path", index + 1);
	}
	return ranked;
}

function compareExactEntries(left: ExactRankedEntry, right: ExactRankedEntry): number {
	return left.tier - right.tier
		|| Number(right.caseExact) - Number(left.caseExact)
		|| compareStableEntry(left.entry, right.entry);
}

function compareFuseEntries(left: FuseRankedEntry, right: FuseRankedEntry): number {
	return Number(right.testMatch) - Number(left.testMatch)
		|| Number(right.caseMatch) - Number(left.caseMatch)
		|| right.exactTokens - left.exactTokens
		|| right.coveredTokens - left.coveredTokens
		|| left.matchScore - right.matchScore
		|| compareStableEntry(left.entry, right.entry);
}

function compareStableEntry(left: FindEntry, right: FindEntry): number {
	const length = left.path.length - right.path.length;
	if (length !== 0) return length;
	const depth = left.depth - right.depth;
	if (depth !== 0) return depth;
	return compareStableString(left.path, right.path);
}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
