import type { WebFetchPage, WebFetchPdf } from "../content/types.ts";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

type CachedResource = Omit<WebFetchPage, "directMedia"> | WebFetchPdf;
interface Snapshot {
	resource: CachedResource;
	createdAt: number;
	sizeBytes: number;
}

export class SnapshotCache {
	private readonly entries = new Map<string, Snapshot>();
	private totalBytes = 0;

	constructor(private readonly now: () => number = () => Date.now()) {}

	get(key: string): WebFetchPage | undefined {
		const resource = this.getResource(key);
		return resource !== undefined && "text" in resource ? resource : undefined;
	}

	getPdf(key: string): WebFetchPdf | undefined {
		const resource = this.getResource(key);
		return resource !== undefined && "bytes" in resource ? resource : undefined;
	}

	set(key: string, value: WebFetchPage): boolean {
		const { directMedia: _media, ...page } = value;
		return this.store(key, page, Buffer.byteLength(page.text, "utf8") + Buffer.byteLength(JSON.stringify(page.analysis), "utf8"));
	}

	setPdf(key: string, value: WebFetchPdf): boolean {
		let size = value.bytes.byteLength;
		for (const text of value.textPages.values()) size += Buffer.byteLength(text, "utf8");
		return this.store(key, value, size);
	}

	clear(): void {
		this.entries.clear();
		this.totalBytes = 0;
	}

	private getResource(key: string): CachedResource | undefined {
		const now = this.now();
		for (const [key, entry] of this.entries) {
			if (now - entry.createdAt > DEFAULT_TTL_MS) this.remove(key, entry);
		}
		const entry = this.entries.get(key);
		if (entry === undefined) return undefined;
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.resource;
	}

	private store(key: string, resource: CachedResource, sizeBytes: number): boolean {
		if (sizeBytes > DEFAULT_MAX_BYTES) return false;
		const existing = this.entries.get(key);
		if (existing !== undefined) this.remove(key, existing);
		this.entries.set(key, { resource, createdAt: this.now(), sizeBytes });
		this.totalBytes += sizeBytes;
		while (this.entries.size > DEFAULT_MAX_ENTRIES || this.totalBytes > DEFAULT_MAX_BYTES) {
			const first = this.entries.entries().next().value;
			if (first === undefined) break;
			this.remove(...first);
		}
		return true;
	}

	private remove(key: string, entry: Snapshot): void {
		this.entries.delete(key);
		this.totalBytes -= entry.sizeBytes;
	}
}
