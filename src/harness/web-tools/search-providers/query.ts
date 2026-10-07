import type { WebSearchParams } from "../core/types.ts";
import type { NormalizedSearchParams } from "./types.ts";

const SITE = /(?:^|\s)(-?)site:(?:"([^"]+)"|(\S+))/giu;

export interface SearchDomainFilters {
	includeDomains?: readonly string[];
	excludeDomains?: readonly string[];
}

export function normalizeSearchParams(params: WebSearchParams, defaultLimit: number, filters: SearchDomainFilters = {}): NormalizedSearchParams {
	const query = params.query.trim();
	const sites = [...query.matchAll(SITE)].map((match) => ({ excluded: match[1] === "-", domain: match[2] ?? match[3] ?? "" }));
	return {
		query,
		limit: params.limit ?? defaultLimit,
		textQuery: withoutSites(query) || query,
		includeDomains: normalizeDomains([...(filters.includeDomains ?? []), ...sites.filter((site) => !site.excluded).map((site) => site.domain)]),
		excludeDomains: normalizeDomains([...(filters.excludeDomains ?? []), ...sites.filter((site) => site.excluded).map((site) => site.domain)]),
	};
}

/** 重建域名操作符，多个包含域名使用 OR 语义。 */
export function filteredLexicalQuery(params: NormalizedSearchParams): string {
	const { includeDomains, excludeDomains } = params;
	const includeClause = includeDomains.length > 1
		? `(${includeDomains.map((domain) => `site:${domain}`).join(" OR ")})`
		: includeDomains[0] === undefined ? undefined : `site:${includeDomains[0]}`;
	return [
		withoutSites(params.query),
		includeClause,
		...excludeDomains.map((domain) => `-site:${domain}`),
	].filter((part): part is string => part !== undefined && part.length > 0).join(" ");
}

function withoutSites(query: string): string {
	return query.replace(SITE, " ").replace(/\s+/gu, " ").trim();
}

export function normalizeDomains(values: readonly string[]): string[] {
	const domains = values.flatMap((value) => {
		const trimmed = value.trim().toLowerCase().replace(/^https?:\/\//u, "").replace(/^\*\./u, "").split("/")[0];
		return trimmed && /^[a-z0-9.-]+$/u.test(trimmed) ? [trimmed.replace(/\.$/u, "")] : [];
	});
	return [...new Set(domains)].sort();
}
