import { setTimeout as delay } from "node:timers/promises";

export const SEARCH_MIN_REQUEST_INTERVAL_MS = 15 * 1000;
export const SEARCH_PROVIDER_BLOCKED_COOLDOWN_MS = 10 * 60 * 1000;

export type SearchRequestGateResult =
	| { status: "ready" }
	| { status: "blocked"; retryAfterMs: number }
	| { status: "aborted"; message: string };

/** 会话内搜索请求闸门；串行化 DDG 请求并在 challenge 后熔断，避免连续请求加重封锁。 */
export class SearchRequestGate {
	private nextRequestAt = 0;
	private blockedUntil = 0;
	private lock: Promise<void> = Promise.resolve();

	constructor(
		private readonly now: () => number = () => Date.now(),
		private readonly minIntervalMs: number = SEARCH_MIN_REQUEST_INTERVAL_MS,
		private readonly blockedCooldownMs: number = SEARCH_PROVIDER_BLOCKED_COOLDOWN_MS,
	) {}

	async beforeRequest(signal?: AbortSignal, onWait?: (waitMs: number) => void): Promise<SearchRequestGateResult> {
		return this.exclusive(async () => {
			const blockedWait = this.blockedUntil - this.now();
			if (blockedWait > 0) return { status: "blocked", retryAfterMs: blockedWait };

			const intervalWait = this.nextRequestAt - this.now();
			if (intervalWait > 0) {
				onWait?.(intervalWait);
				const wait = await sleep(intervalWait, signal);
				if (wait.status === "aborted") return wait;
			}
			this.nextRequestAt = this.now() + this.minIntervalMs;
			return { status: "ready" };
		});
	}

	markProviderBlocked(): void {
		this.blockedUntil = Math.max(this.blockedUntil, this.now() + this.blockedCooldownMs);
	}

	clear(): void {
		this.nextRequestAt = 0;
		this.blockedUntil = 0;
		this.lock = Promise.resolve();
	}

	private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.lock;
		let unlock: () => void = () => undefined;
		this.lock = new Promise<void>((resolve) => {
			unlock = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			unlock();
		}
	}
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<{ status: "ready" } | { status: "aborted"; message: string }> {
	if (ms <= 0) return { status: "ready" };
	if (signal?.aborted) return { status: "aborted", message: "search request was aborted before rate-limit wait completed." };
	try {
		await delay(ms, undefined, signal === undefined ? undefined : { signal });
		return { status: "ready" };
	} catch {
		return { status: "aborted", message: "search request was aborted during rate-limit wait." };
	}
}
