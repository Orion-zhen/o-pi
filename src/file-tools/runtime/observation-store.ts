import type { ContentVersion } from "../../filesystem/contracts/content.js";
import type { AnyPathRef } from "../../filesystem/contracts/path.js";
import type { WorkspaceNativeBridge } from "../../filesystem/runtime.js";

export interface ObservationEntry {
	readonly canonicalPath: string;
	readonly version: ContentVersion;
}

/** Session-owned observations keyed by canonical filesystem identity. */
export class ObservationStore {
	private readonly observations = new Map<string, ObservationEntry>();
	private readonly bridges = new Map<WorkspaceNativeBridge, number>();
	private disposed = false;

	constructor(initial: readonly ObservationEntry[] = []) {
		for (const observation of initial) {
			this.observations.set(canonicalKey(observation.canonicalPath), {
				canonicalPath: observation.canonicalPath,
				version: copyVersion(observation.version),
			});
		}
	}

	attach(bridge: WorkspaceNativeBridge): () => void {
		if (this.disposed) return () => {};
		this.bridges.set(bridge, (this.bridges.get(bridge) ?? 0) + 1);
		let attached = true;
		return () => {
			if (!attached) return;
			attached = false;
			const count = this.bridges.get(bridge) ?? 0;
			if (count <= 1) this.bridges.delete(bridge);
			else this.bridges.set(bridge, count - 1);
		};
	}

	remember(ref: AnyPathRef, version: ContentVersion): boolean {
		const identity = this.identityFor(ref);
		if (identity === undefined) return false;
		this.observations.set(identity.key, {
			canonicalPath: identity.canonicalPath,
			version: copyVersion(version),
		});
		return true;
	}

	get(ref: AnyPathRef): ContentVersion | undefined {
		const key = this.keyFor(ref);
		const entry = key === undefined ? undefined : this.observations.get(key);
		return entry === undefined ? undefined : copyVersion(entry.version);
	}

	entries(): readonly ObservationEntry[] {
		return [...this.observations.values()];
	}

	get size(): number {
		return this.observations.size;
	}

	forget(ref: AnyPathRef): boolean {
		const key = this.keyFor(ref);
		return key === undefined ? false : this.observations.delete(key);
	}

	clear(): void {
		this.observations.clear();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clear();
		this.bridges.clear();
	}

	private keyFor(ref: AnyPathRef): string | undefined {
		return this.identityFor(ref)?.key;
	}

	private identityFor(ref: AnyPathRef): { readonly key: string; readonly canonicalPath: string } | undefined {
		if (this.disposed) return undefined;
		for (const bridge of this.bridges.keys()) {
			const identity = bridge.getNativeIdentity(ref);
			if (identity === undefined) continue;
			return {
				key: canonicalKey(identity.canonicalPath),
				canonicalPath: identity.canonicalPath,
			};
		}
		return undefined;
	}
}

function canonicalKey(canonicalPath: string): string {
	return process.platform === "win32" ? canonicalPath.toLocaleLowerCase() : canonicalPath;
}

function copyVersion(version: ContentVersion): ContentVersion {
	return { hash: version.hash, sizeBytes: version.sizeBytes };
}
