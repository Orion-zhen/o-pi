import { collectUsageSnapshot, type UsageContext } from "./client.js";
import type { UsageSnapshot } from "./types.js";

const DEFAULT_CACHE_MS = 60_000;

export interface UsageServiceOptions {
	fetchImpl?: typeof fetch;
	clock?: () => number;
}

export interface UsageLoadOptions {
	refresh: boolean;
	signal: AbortSignal | undefined;
}

/** 为 /usage 提供短期内存缓存和并发请求合并。缓存中不含 OAuth 凭据。 */
export class UsageService {
	private cached: { loadedAt: number; snapshot: UsageSnapshot } | undefined;
	private inFlight: Promise<UsageSnapshot> | undefined;
	private readonly clock: () => number;

	constructor(private readonly options: UsageServiceOptions = {}) {
		this.clock = options.clock ?? Date.now;
	}

	async load(context: UsageContext, options: UsageLoadOptions): Promise<UsageSnapshot> {
		const now = this.clock();
		if (!options.refresh && this.cached !== undefined) {
			const age = now - this.cached.loadedAt;
			if (age >= 0 && age < DEFAULT_CACHE_MS) return this.cached.snapshot;
		}
		if (this.inFlight !== undefined) return this.inFlight;

		const request = collectUsageSnapshot(context, {
			fetchImpl: this.options.fetchImpl ?? fetch,
			signal: options.signal,
			now: new Date(now),
		});
		this.inFlight = request;
		try {
			const snapshot = await request;
			if (snapshot.providers.every((provider) => provider.status !== "error")) {
				this.cached = { loadedAt: this.clock(), snapshot };
			}
			return snapshot;
		} finally {
			this.inFlight = undefined;
		}
	}
}
