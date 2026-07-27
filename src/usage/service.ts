import { collectUsageSnapshot, type UsageClientOptions, type UsageContext, type UsageFetch } from "./client.js";
import type { UsageSnapshot } from "./types.js";

const DEFAULT_CACHE_MS = 60_000;

export interface UsageServiceOptions {
	fetchImpl?: UsageFetch;
	timeoutMs?: number;
	optionalTimeoutMs?: number;
	cacheMs?: number;
	clock?: () => number;
}

export interface UsageLoadOptions {
	refresh?: boolean;
	signal?: AbortSignal;
}

/** 为 /usage 提供短期内存缓存和并发请求合并；缓存中不含 OAuth 凭据。 */
export class UsageService {
	private cached: { loadedAt: number; snapshot: UsageSnapshot } | undefined;
	private inFlight: Promise<UsageSnapshot> | undefined;
	private readonly clock: () => number;
	private readonly cacheMs: number;

	constructor(private readonly options: UsageServiceOptions = {}) {
		this.clock = options.clock ?? Date.now;
		this.cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
	}

	async load(context: UsageContext, options: UsageLoadOptions = {}): Promise<UsageSnapshot> {
		const now = this.clock();
		const age = this.cached === undefined ? undefined : now - this.cached.loadedAt;
		if (options.refresh !== true && this.cached !== undefined && age !== undefined && age >= 0 && age < this.cacheMs) {
			return this.cached.snapshot;
		}
		if (this.inFlight !== undefined) return this.inFlight;

		const request = collectUsageSnapshot(context, this.clientOptions(new Date(now), options.signal));
		this.inFlight = request;
		try {
			const snapshot = await request;
			this.cached = { loadedAt: this.clock(), snapshot };
			return snapshot;
		} finally {
			if (this.inFlight === request) this.inFlight = undefined;
		}
	}

	private clientOptions(now: Date, signal: AbortSignal | undefined): UsageClientOptions {
		return {
			now,
			...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
			...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
			...(this.options.optionalTimeoutMs === undefined ? {} : { optionalTimeoutMs: this.options.optionalTimeoutMs }),
			...(signal === undefined ? {} : { signal }),
		};
	}
}
