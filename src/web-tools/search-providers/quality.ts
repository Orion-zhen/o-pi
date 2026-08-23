import { getDomain } from "tldts";

import type { WebSearchItem } from "../core/types.js";
import type { CompiledSearchQuery } from "./types.js";

export type SearchQuality = "accepted" | "partial" | "soft_miss" | "hard_failure";

export interface QualityAssessment {
	quality: Exclude<SearchQuality, "hard_failure">;
	usableResults: WebSearchItem[];
}

export function assessSearchQuality(results: readonly WebSearchItem[], query: CompiledSearchQuery, requestedLimit: number): QualityAssessment {
	const usableResults = results.filter((item) => usable(item, query));
	if (usableResults.length === 0) return { quality: "soft_miss", usableResults: [] };
	const target = Math.min(requestedLimit, query.navigation ? 2 : 5);
	const top = usableResults.slice(0, 3);
	const relevanceScore = query.keyTerms.length === 0 ? 1 : top.reduce((sum, item) => sum + matchRatio(item, query.keyTerms), 0) / Math.max(1, top.length);
	const snippetCoverage = usableResults.filter((item) => (item.snippet?.trim().length ?? 0) >= 24).length / usableResults.length;
	const domains = new Set(usableResults.map((item) => registrableDomain(item.url)).filter(Boolean));
	const diversityScore = query.navigation ? 1 : Math.min(1, domains.size / Math.min(3, usableResults.length));
	const accepted = usableResults.length >= target && relevanceScore >= 0.34 && snippetCoverage >= 0.4 && (query.navigation || diversityScore >= 0.5);
	return {
		quality: accepted ? "accepted" : "partial",
		usableResults,
	};
}

function usable(item: WebSearchItem, query: CompiledSearchQuery): boolean {
	let url: URL;
	try { url = new URL(item.url); } catch { return false; }
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (query.includeDomains.length > 0 && !query.includeDomains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return false;
	if (query.excludeDomains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return false;
	return query.keyTerms.length === 0 || matchesTerms(item, query.keyTerms) || query.navigation && query.includeDomains.length > 0;
}

function matchesTerms(item: WebSearchItem, terms: readonly string[]): boolean {
	return matchRatio(item, terms) > 0;
}

function matchRatio(item: WebSearchItem, terms: readonly string[]): number {
	const haystack = `${item.title} ${item.snippet ?? ""} ${item.url}`.toLowerCase();
	return terms.length === 0 ? 1 : terms.filter((term) => haystack.includes(term)).length / terms.length;
}

function registrableDomain(raw: string): string {
	try { return getDomain(new URL(raw).hostname) ?? new URL(raw).hostname; } catch { return ""; }
}
