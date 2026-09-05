import type { WebFetchPage } from "../core/types.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

interface Snapshot {
	page: Omit<WebFetchPage, "directMedia">;
	createdAt: number;
	sizeBytes: number;
}

export class SnapshotCache {
	private readonly entries = new Map<string, Snapshot>();
	private totalBytes = 0;

	constructor(
		private readonly now: () => number = () => Date.now(),
	) {}

	get(key: string): WebFetchPage | undefined {
		const now = this.now();
		for (const [key, entry] of this.entries) {
			if (now - entry.createdAt > DEFAULT_TTL_MS) this.remove(key, entry);
		}
		const entry = this.entries.get(key);
		if (entry === undefined) return undefined;
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.page;
	}

	set(key: string, value: WebFetchPage): void {
		const { directMedia: _media, ...page } = value;
		const sizeBytes = Buffer.byteLength(page.text, "utf8") + Buffer.byteLength(JSON.stringify(page.analysis), "utf8");
		if (sizeBytes > DEFAULT_MAX_BYTES) return;
		const existing = this.entries.get(key);
		if (existing !== undefined) this.remove(key, existing);
		this.entries.set(key, { page, sizeBytes, createdAt: this.now() });
		this.totalBytes += sizeBytes;
		while (this.entries.size > DEFAULT_MAX_ENTRIES || this.totalBytes > DEFAULT_MAX_BYTES) {
			const first = this.entries.entries().next().value;
			if (first === undefined) break;
			this.remove(...first);
		}
	}

	clear(): void {
		this.entries.clear();
		this.totalBytes = 0;
	}

	private remove(key: string, entry: Snapshot): void {
		this.entries.delete(key);
		this.totalBytes -= entry.sizeBytes;
	}
}
