import type { FormalWebSearchProviderId, WebSearchItem } from "./types.js";
import type { NormalizedSearchParams } from "./search-providers/types.js";
import { normalizeSearchResultUrl } from "./url-utils.js";

interface CorpusEntry {
	query: string;
	tokens: Set<string>;
	filters: string;
	results: WebSearchItem[];
	providers: FormalWebSearchProviderId[];
	createdAt: number;
}

interface CorpusUrlState {
	fetched: boolean;
	cited: boolean;
}

export class SearchCorpus {
	private readonly entries: CorpusEntry[] = [];
	private readonly urls = new Map<string, CorpusUrlState>();
	private readonly queries: Array<{ tokens: Set<string>; filters: string; at: number }> = [];

	constructor(private readonly now: () => number = () => Date.now(), private readonly maxEntries = 32) {}

	find(params: NormalizedSearchParams): WebSearchItem[] | undefined {
		const tokens = queryTokens(params.compiled.semanticQuery);
		const filters = filterKey(params);
		const candidate = this.entries
			.filter((entry) => this.now() - entry.createdAt <= 600_000 && entry.filters === filters && entry.results.length >= Math.min(params.limit, 5) && similarity(tokens, entry.tokens) >= 0.75)
			.sort((left, right) => right.createdAt - left.createdAt)[0];
		return candidate?.results.slice(0, params.limit).map((item, index) => ({ ...item, rank: index + 1 }));
	}

	recordQuery(params: NormalizedSearchParams): boolean {
		const tokens = queryTokens(params.compiled.semanticQuery);
		const filters = filterKey(params);
		const reformulated = this.queries.some((entry) => this.now() - entry.at <= 120_000 && entry.filters === filters && similarity(tokens, entry.tokens) >= 0.55 && similarity(tokens, entry.tokens) < 1);
		this.queries.push({ tokens, filters, at: this.now() });
		while (this.queries.length > 32) this.queries.shift();
		return reformulated;
	}

	add(params: NormalizedSearchParams, results: readonly WebSearchItem[], providers: readonly FormalWebSearchProviderId[]): void {
		if (results.length === 0) return;
		this.entries.push({ query: params.query, tokens: queryTokens(params.compiled.semanticQuery), filters: filterKey(params), results: results.map((item) => ({ ...item })), providers: [...providers], createdAt: this.now() });
		for (const item of results) this.urls.set(item.url, this.urls.get(item.url) ?? { fetched: false, cited: false });
		while (this.entries.length > this.maxEntries) this.entries.shift();
	}

	markFetched(url: string): void { this.mark(url, "fetched"); }
	markCited(url: string): void { this.mark(url, "cited"); }
	usage(): { discovered: number; fetched: number; cited: number } {
		const states = [...this.urls.values()];
		return { discovered: states.length, fetched: states.filter((state) => state.fetched).length, cited: states.filter((state) => state.cited).length };
	}

	clear(): void { this.entries.length = 0; this.queries.length = 0; this.urls.clear(); }

	private mark(raw: string, field: keyof CorpusUrlState): void {
		const normalized = normalizeUrl(raw);
		if (normalized === undefined) return;
		for (const [url, state] of this.urls) if (normalizeUrl(url) === normalized) state[field] = true;
	}
}

function filterKey(params: NormalizedSearchParams): string {
	const freshness = typeof params.freshness === "object" ? [params.freshness.start ?? null, params.freshness.end ?? null] : params.freshness ?? null;
	return JSON.stringify([freshness, params.includeDomains, params.excludeDomains]);
}
function queryTokens(value: string): Set<string> { return new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []); }
function similarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number { if (left.size === 0 || right.size === 0) return 0; const intersection = [...left].filter((token) => right.has(token)).length; return intersection / (left.size + right.size - intersection); }
function normalizeUrl(raw: string): string | undefined { return normalizeSearchResultUrl(raw)?.toString(); }
