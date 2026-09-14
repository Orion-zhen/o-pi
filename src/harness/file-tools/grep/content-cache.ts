import type { TextContent } from "../../filesystem/contracts/content.js";
import type { FileMetadata } from "../../filesystem/contracts/metadata.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import type { ScopedFile } from "./inventory.js";

interface CachedTextContent {
	readonly content: TextContent;
	readonly sizeBytes: number;
}

interface CacheLimits {
	readonly bytes: number;
	readonly entries: number;
}

export interface GrepContentCacheLease {
	get(file: ScopedFile, filesystem: WorkspaceFileSystem, operation: FsOperationContext): Promise<TextContent | undefined>;
	set(file: ScopedFile, filesystem: WorkspaceFileSystem, content: TextContent): void;
	dispose(): void;
}

/** 跨 grep invocation 复用已稳定读取的正文；命中仍按当前路径和 snapshot 复验。 */
export class GrepContentCache {
	private readonly entries = new Map<string, CachedTextContent>();
	private readonly activeLimits = new Map<symbol, CacheLimits>();
	private capacityBytes = 0;
	private capacityEntries = 0;
	private retainedCapacityBytes = 0;
	private retainedCapacityEntries = 0;
	private usedBytes = 0;
	private disposed = false;

	acquire(capacityBytes: number, capacityEntries: number): GrepContentCacheLease {
		const id = Symbol("grep-content-cache-lease");
		if (!this.disposed) {
			this.retainedCapacityBytes = capacityBytes;
			this.retainedCapacityEntries = capacityEntries;
			this.activeLimits.set(id, { bytes: capacityBytes, entries: capacityEntries });
			this.resize();
		}
		let released = false;
		return {
			get: (file, filesystem, operation) => released
				? Promise.resolve(undefined)
				: this.get(id, file, filesystem, operation),
			set: (file, filesystem, content) => {
				if (!released) this.set(id, file, filesystem, content);
			},
			dispose: () => {
				if (released) return;
				released = true;
				this.release(id);
			},
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.activeLimits.clear();
		this.entries.clear();
		this.usedBytes = 0;
		this.capacityBytes = 0;
		this.capacityEntries = 0;
		this.retainedCapacityBytes = 0;
		this.retainedCapacityEntries = 0;
	}

	private async get(
		id: symbol,
		file: ScopedFile,
		filesystem: WorkspaceFileSystem,
		operation: FsOperationContext,
	): Promise<TextContent | undefined> {
		if (!this.activeLimits.has(id) || this.disposed || this.capacityBytes === 0 || this.capacityEntries === 0) return undefined;
		const key = cacheKey(file, filesystem);
		const cached = this.entries.get(key);
		if (cached === undefined) return undefined;

		const resolved = await filesystem.paths.resolveExisting(file.path, {
			expected: "file",
			followFinalSymlink: false,
		});
		if (!resolved.ok) {
			if (resolved.error.code !== "aborted") this.delete(key, cached);
			return undefined;
		}
		const metadata = await filesystem.metadata.stat(resolved.value);
		if (!metadata.ok) {
			if (metadata.error.code !== "aborted") this.delete(key, cached);
			return undefined;
		}
		if (operation.signal?.aborted === true) return undefined;
		if (!sameSnapshot(file, metadata.value)) {
			this.delete(key, cached);
			return undefined;
		}
		// 其他 lease 的缩容或 owner dispose 可在 metadata I/O 期间触发淘汰。
		if (this.disposed || this.capacityBytes === 0 || this.capacityEntries === 0 || this.entries.get(key) !== cached) return undefined;
		this.entries.delete(key);
		this.entries.set(key, cached);
		return cached.content;
	}

	private set(id: symbol, file: ScopedFile, filesystem: WorkspaceFileSystem, content: TextContent): void {
		if (
			!this.activeLimits.has(id)
			|| this.disposed
			|| this.capacityBytes === 0
			|| this.capacityEntries === 0
			|| content.sizeBytes > this.capacityBytes
		) return;
		const key = cacheKey(file, filesystem);
		const current = this.entries.get(key);
		if (current !== undefined) this.delete(key, current);
		const cached = { content, sizeBytes: content.sizeBytes };
		this.entries.set(key, cached);
		this.usedBytes += cached.sizeBytes;
		this.evictOverflow();
	}

	private release(id: symbol): void {
		if (!this.activeLimits.delete(id)) return;
		this.resize();
	}

	private resize(): void {
		this.capacityBytes = this.activeLimits.size === 0 ? this.retainedCapacityBytes : Number.MAX_SAFE_INTEGER;
		this.capacityEntries = this.activeLimits.size === 0 ? this.retainedCapacityEntries : Number.MAX_SAFE_INTEGER;
		for (const limits of this.activeLimits.values()) {
			this.capacityBytes = Math.min(this.capacityBytes, limits.bytes);
			this.capacityEntries = Math.min(this.capacityEntries, limits.entries);
		}
		this.evictOverflow();
	}

	private evictOverflow(): void {
		while (this.usedBytes > this.capacityBytes || this.entries.size > this.capacityEntries) {
			const oldest = this.entries.entries().next().value;
			if (oldest === undefined) break;
			this.delete(oldest[0], oldest[1]);
		}
	}

	private delete(key: string, cached: CachedTextContent): void {
		if (this.entries.get(key) !== cached) return;
		this.entries.delete(key);
		this.usedBytes -= cached.sizeBytes;
	}
}

function cacheKey(file: ScopedFile, filesystem: WorkspaceFileSystem): string {
	return [
		filesystem.identity,
		file.path,
		file.snapshot.identity,
		file.snapshot.version,
		file.snapshot.sizeBytes,
	].join("\0");
}

function sameSnapshot(file: ScopedFile, metadata: FileMetadata): boolean {
	return metadata.kind === "file"
		&& metadata.identity === file.snapshot.identity
		&& metadata.version === file.snapshot.version
		&& metadata.sizeBytes === file.snapshot.sizeBytes;
}
