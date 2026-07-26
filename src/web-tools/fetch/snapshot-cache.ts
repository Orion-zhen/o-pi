import type { WebFetchSnapshot } from "../core/types.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export class SnapshotCache {
	private readonly entries = new Map<string, WebFetchSnapshot>();
	private totalBytes = 0;

	constructor(
		private readonly now: () => number = () => Date.now(),
		private readonly ttlMs = DEFAULT_TTL_MS,
		private readonly maxEntries = DEFAULT_MAX_ENTRIES,
		private readonly maxBytes = DEFAULT_MAX_BYTES,
	) {}

	get(key: string): WebFetchSnapshot | undefined {
		this.evictExpired();
		const entry = this.entries.get(key);
		if (entry === undefined) return undefined;
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry;
	}

	set(snapshot: WebFetchSnapshot): void {
		if (snapshot.sizeBytes > this.maxBytes) return;
		const existing = this.entries.get(snapshot.key);
		if (existing !== undefined) {
			this.totalBytes -= existing.sizeBytes;
			this.entries.delete(snapshot.key);
		}
		this.entries.set(snapshot.key, snapshot);
		this.totalBytes += snapshot.sizeBytes;
		this.evictToLimits();
	}

	clear(): void {
		this.entries.clear();
		this.totalBytes = 0;
	}

	private evictExpired(): void {
		const now = this.now();
		for (const [key, entry] of this.entries) {
			if (now - entry.createdAt > this.ttlMs) {
				this.entries.delete(key);
				this.totalBytes -= entry.sizeBytes;
			}
		}
	}

	private evictToLimits(): void {
		while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
			const first = this.entries.keys().next().value as string | undefined;
			if (first === undefined) return;
			const entry = this.entries.get(first);
			this.entries.delete(first);
			if (entry !== undefined) this.totalBytes -= entry.sizeBytes;
		}
	}
}
