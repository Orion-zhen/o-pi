import type { ContentVersion } from "../../filesystem/contracts/content.js";
import type { AnyPathRef } from "../../filesystem/contracts/path.js";
import type { WorkspaceNativeBridge } from "../../filesystem/runtime.js";

/** Session-owned observations keyed by canonical filesystem identity. */
export class ObservationStore {
	private readonly observations = new Map<string, ContentVersion>();
	private readonly bridges = new Map<WorkspaceNativeBridge, number>();
	private disposed = false;

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
		const key = this.keyFor(ref);
		if (key === undefined) return false;
		this.observations.set(key, { hash: version.hash, sizeBytes: version.sizeBytes });
		return true;
	}

	get(ref: AnyPathRef): ContentVersion | undefined {
		const key = this.keyFor(ref);
		const version = key === undefined ? undefined : this.observations.get(key);
		return version === undefined ? undefined : { ...version };
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
		if (this.disposed) return undefined;
		for (const bridge of this.bridges.keys()) {
			const identity = bridge.getNativeIdentity(ref);
			if (identity === undefined) continue;
			return process.platform === "win32" ? identity.canonicalPath.toLocaleLowerCase() : identity.canonicalPath;
		}
		return undefined;
	}
}
