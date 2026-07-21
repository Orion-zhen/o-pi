import type { WebSearchParams } from "../types.js";
import type { CompiledSearchQuery, NormalizedSearchParams, SearchIntent } from "./types.js";

const OPERATOR = /-?\b(?:site|filetype|intitle|inurl|before|after):(?:"[^"]+"|\S+)/giu;
const OPERATOR_SIGNAL = /\b(?:site|filetype|intitle|inurl|before|after):/iu;
const SITE = /(?:^|\s)(-?)site:(?:"([^"]+)"|(\S+))/giu;
const EXACT_SIGNAL = /(?:"[^"]+"|\b(?:[A-Z]{1,8}-?\d{2,}|0x[\da-f]+|v?\d+\.\d+(?:\.\d+)?)\b|\b(?:error|exception|failed|status code)\b)/iu;
const NEWS_SIGNAL = /\b(?:latest|today|current|news|breaking|update|status|release|最近|最新|今天|新闻|现状)\b/iu;
const PAPER_SIGNAL = /\b(?:paper|papers|research|study|arxiv|doi|journal|conference|论文|研究|文献)\b/iu;
const NAVIGATION_SIGNAL = /\b(?:official|docs?|documentation|homepage|website|github|官网|官方|文档)\b/iu;
const SEMANTIC_SIGNAL = /\b(?:find|discover|compare|approach|technique|method|examples? of|similar to|如何|寻找|比较|方法)\b/iu;
const STOP_WORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "with", "is", "are", "what", "how"]);

export interface SearchDomainFilters {
	includeDomains?: readonly string[];
	excludeDomains?: readonly string[];
}

export function normalizeSearchParams(params: WebSearchParams, defaultLimit: number, filters: SearchDomainFilters = {}): NormalizedSearchParams {
	const query = params.query.trim();
	const queryCompiled = compileSearchQuery({ ...params, query });
	const includeDomains = normalizeDomains([...(filters.includeDomains ?? []), ...queryCompiled.includeDomains]);
	const excludeDomains = normalizeDomains([...(filters.excludeDomains ?? []), ...queryCompiled.excludeDomains]);
	const compiled = { ...queryCompiled, includeDomains, excludeDomains };
	return {
		query,
		limit: params.limit ?? defaultLimit,
		...(compiled.freshness !== undefined ? { freshness: compiled.freshness } : {}),
		includeDomains: compiled.includeDomains,
		excludeDomains: compiled.excludeDomains,
		compiled,
	};
}

/** Rebuild domain operators so multiple included domains retain OR semantics across lexical providers. */
export function filteredLexicalQuery(params: Pick<NormalizedSearchParams, "compiled" | "includeDomains" | "excludeDomains">): string {
	const lexicalQuery = params.compiled.lexicalQuery.replace(SITE, " ").replace(/\s+/gu, " ").trim();
	const includeClause = params.includeDomains.length > 1
		? `(${params.includeDomains.map((domain) => `site:${domain}`).join(" OR ")})`
		: params.includeDomains[0] === undefined ? undefined : `site:${params.includeDomains[0]}`;
	return [
		lexicalQuery,
		includeClause,
		...params.excludeDomains.map((domain) => `-site:${domain}`),
	].filter((part): part is string => part !== undefined && part.length > 0).join(" ");
}

export function compileSearchQuery(params: WebSearchParams): CompiledSearchQuery {
	const lexicalQuery = params.query.trim().replace(/\s+/gu, " ");
	const siteOperators = [...lexicalQuery.matchAll(SITE)].map((match) => ({ excluded: match[1] === "-", domains: normalizeDomains([match[2] ?? match[3] ?? ""]) }));
	const includeDomains = normalizeDomains(siteOperators.filter((site) => !site.excluded).flatMap((site) => site.domains));
	const excludeDomains = normalizeDomains(siteOperators.filter((site) => site.excluded).flatMap((site) => site.domains));
	const semanticQuery = lexicalQuery.replace(OPERATOR, " ").replace(/\s+/gu, " ").trim();
	const intent = classifySearchIntent(lexicalQuery, semanticQuery);
	const freshness = params.freshness ?? operatorFreshness(lexicalQuery);
	return {
		originalQuery: params.query.trim(),
		lexicalQuery,
		semanticQuery: semanticQuery || lexicalQuery,
		intent,
		includeDomains,
		excludeDomains,
		...(freshness !== undefined ? { freshness } : {}),
		keyTerms: keyTerms(semanticQuery || lexicalQuery),
		navigation: siteOperators.length > 0 || NAVIGATION_SIGNAL.test(lexicalQuery),
	};
}

export function classifySearchIntent(lexicalQuery: string, semanticQuery = lexicalQuery): SearchIntent {
	if (PAPER_SIGNAL.test(lexicalQuery)) return "paper";
	if (EXACT_SIGNAL.test(lexicalQuery) || OPERATOR_SIGNAL.test(lexicalQuery)) return "exact";
	if (NAVIGATION_SIGNAL.test(lexicalQuery)) return "navigation";
	if (NEWS_SIGNAL.test(lexicalQuery)) return "news";
	const words = semanticQuery.split(/\s+/u).filter(Boolean);
	if (words.length >= 12 || SEMANTIC_SIGNAL.test(semanticQuery) && words.length >= 7) return "semantic";
	if (/^(?:who|what|when|where|which|how many|多少|谁|什么|何时|哪里)\b/iu.test(semanticQuery)) return "fact";
	return "general";
}

function operatorFreshness(value: string): { start?: string; end?: string } | undefined {
	const start = /\bafter:(\d{4}-\d{2}-\d{2})\b/iu.exec(value)?.[1];
	const end = /\bbefore:(\d{4}-\d{2}-\d{2})\b/iu.exec(value)?.[1];
	return start === undefined && end === undefined ? undefined : { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) };
}

export function normalizeDomains(values: readonly string[]): string[] {
	const domains = values.flatMap((value) => {
		const trimmed = value.trim().toLowerCase().replace(/^https?:\/\//u, "").replace(/^\*\./u, "").split("/")[0];
		return trimmed && /^[a-z0-9.-]+$/u.test(trimmed) ? [trimmed.replace(/\.$/u, "")] : [];
	});
	return [...new Set(domains)].sort();
}

function keyTerms(value: string): string[] {
	return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? [])]
		.filter((term) => term.length > 1 && !STOP_WORDS.has(term))
		.slice(0, 12);
}
