import { getDomain } from "tldts";

import type { FormalWebSearchProviderId, WebSearchItem } from "../types.js";
import { normalizeSearchResultUrl, normalizeSearchText } from "../url-utils.js";

const RRF_K = 60;

interface Candidate extends WebSearchItem {
	key: string;
	providers: Map<FormalWebSearchProviderId, number>;
	rrf: number;
}

export function mergeSearchResults(
	inputs: readonly { provider: FormalWebSearchProviderId; weight: number; results: readonly WebSearchItem[] }[],
	limit: number,
): WebSearchItem[] {
	const candidates: Candidate[] = [];
	for (const input of inputs) {
		for (const item of input.results) {
			const url = normalizeSearchResultUrl(item.url)?.toString();
			if (url === undefined) continue;
			let candidate = candidates.find((existing) => duplicate(existing, item, url));
			if (candidate === undefined) {
				candidate = { ...item, url, key: url, providers: new Map(), rrf: 0 };
				candidates.push(candidate);
			} else if (item.snippet !== undefined && item.snippet.length > (candidate.snippet?.length ?? 0)) {
				candidate.snippet = item.snippet;
			}
			candidate.providers.set(input.provider, item.rank);
			candidate.rrf += input.weight / (RRF_K + item.rank);
		}
	}
	for (const candidate of candidates) if (candidate.providers.size > 1) candidate.rrf += 0.02;
	candidates.sort((left, right) => right.rrf - left.rrf || left.rank - right.rank);
	const domainCounts = new Map<string, number>();
	const selected: WebSearchItem[] = [];
	for (const candidate of candidates) {
		const domain = registrableDomain(candidate.url);
		if ((domainCounts.get(domain) ?? 0) >= 2) continue;
		domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
		selected.push(toOutput(candidate, selected.length + 1));
		if (selected.length >= limit) break;
	}
	return selected;
}

function toOutput(candidate: Candidate, rank: number): WebSearchItem {
	return { rank, title: candidate.title, url: candidate.url, ...(candidate.snippet !== undefined ? { snippet: candidate.snippet } : {}), ...(candidate.published_date !== undefined ? { published_date: candidate.published_date } : {}), ...(candidate.score !== undefined ? { score: candidate.score } : {}), provenance: [...candidate.providers].map(([provider, providerRank]) => ({ provider, rank: providerRank })) };
}

function duplicate(candidate: Candidate, item: WebSearchItem, normalizedUrl: string): boolean {
	if (candidate.key === normalizedUrl) return true;
	const left = safeUrl(candidate.url);
	const right = safeUrl(normalizedUrl);
	if (left !== undefined && right !== undefined && left.hostname === right.hostname && normalizePath(left.pathname) === normalizePath(right.pathname)) return true;
	return titleSimilarity(candidate.title, item.title) >= 0.9;
}

function titleSimilarity(left: string, right: string): number {
	const a = titleTokens(left);
	const b = titleTokens(right);
	if (a.size === 0 || b.size === 0) return 0;
	if (Math.min(a.size, b.size) < 3 && !(normalizeSearchText(left).length >= 16 && normalizeSearchText(left).toLowerCase() === normalizeSearchText(right).toLowerCase())) return 0;
	const intersection = [...a].filter((token) => b.has(token)).length;
	return intersection / (a.size + b.size - intersection);
}

function titleTokens(value: string): Set<string> {
	return new Set(normalizeSearchText(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function normalizePath(value: string): string { return value.replace(/\/+$/u, "") || "/"; }
function safeUrl(value: string): URL | undefined { try { return new URL(value); } catch { return undefined; } }
function registrableDomain(value: string): string { const url = safeUrl(value); return url === undefined ? value : getDomain(url.hostname) ?? url.hostname; }
