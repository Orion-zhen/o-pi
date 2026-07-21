import { getDomain } from "tldts";

import type { WebSearchItem } from "../types.js";
import type { CompiledSearchQuery } from "./types.js";

export type SearchQuality = "accepted" | "partial" | "soft_miss" | "hard_failure";

export interface QualityAssessment {
	quality: Exclude<SearchQuality, "hard_failure">;
	score: number;
	usableResults: WebSearchItem[];
	reasons: string[];
}

export function assessSearchQuality(results: readonly WebSearchItem[], query: CompiledSearchQuery, requestedLimit: number, now = Date.now()): QualityAssessment {
	const usableResults = results.filter((item) => usable(item, query));
	if (usableResults.length === 0) return { quality: "soft_miss", score: 0, usableResults: [], reasons: ["no_relevant_results"] };
	const target = Math.min(requestedLimit, query.navigation ? 2 : 5);
	const top = usableResults.slice(0, 3);
	const relevanceScore = query.keyTerms.length === 0 ? 1 : top.reduce((sum, item) => sum + matchRatio(item, query.keyTerms), 0) / Math.max(1, top.length);
	const snippetCoverage = usableResults.filter((item) => (item.snippet?.trim().length ?? 0) >= 24).length / usableResults.length;
	const domains = new Set(usableResults.map((item) => registrableDomain(item.url)).filter(Boolean));
	const native = usableResults.flatMap((item) => item.score === undefined ? [] : [clamp(item.score)]);
	const nativeScore = native.length === 0 ? 0.5 : native.reduce((sum, score) => sum + score, 0) / native.length;
	const freshness = freshnessCoverage(usableResults, query, now);
	const countScore = Math.min(1, usableResults.length / Math.max(1, target));
	const diversityScore = query.navigation ? 1 : Math.min(1, domains.size / Math.min(3, usableResults.length));
	const score = 0.3 * countScore + 0.3 * relevanceScore + 0.15 * snippetCoverage + 0.1 * diversityScore + 0.1 * freshness + 0.05 * nativeScore;
	const accepted = usableResults.length >= target && relevanceScore >= 0.34 && snippetCoverage >= 0.4 && (query.navigation || diversityScore >= 0.5) && freshness >= 0.5;
	return {
		quality: accepted ? "accepted" : "partial",
		score,
		usableResults,
		reasons: accepted ? [] : [
			...(usableResults.length < target ? ["too_few_results"] : []),
			...(relevanceScore < 0.34 ? ["weak_term_match"] : []),
			...(snippetCoverage < 0.4 ? ["low_snippet_coverage"] : []),
			...(!query.navigation && diversityScore < 0.5 ? ["low_domain_diversity"] : []),
			...(freshness < 0.5 ? ["freshness_miss"] : []),
		],
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

function freshnessCoverage(results: readonly WebSearchItem[], query: CompiledSearchQuery, now: number): number {
	if (query.freshness === undefined) return 1;
	const dates = results.flatMap((item) => item.published_date === undefined ? [] : [Date.parse(item.published_date)]).filter(Number.isFinite);
	if (dates.length === 0) return 0.5;
	const start = freshnessStart(query.freshness, now);
	const end = typeof query.freshness === "object" && query.freshness.end !== undefined ? Date.parse(`${query.freshness.end}T23:59:59Z`) : now;
	return dates.filter((date) => date >= start && date <= end).length / dates.length;
}

function freshnessStart(freshness: NonNullable<CompiledSearchQuery["freshness"]>, now: number): number {
	if (typeof freshness === "object") return freshness.start === undefined ? 0 : Date.parse(`${freshness.start}T00:00:00Z`);
	const days = { day: 1, week: 7, month: 31, year: 365 }[freshness];
	return now - days * 86_400_000;
}

function registrableDomain(raw: string): string {
	try { return getDomain(new URL(raw).hostname) ?? new URL(raw).hostname; } catch { return ""; }
}

function clamp(value: number): number {
	return Math.max(0, Math.min(1, value));
}
