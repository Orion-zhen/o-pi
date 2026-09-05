import type { ContentVersion } from "../../filesystem/contracts/content.js";
import type { AnyPathRef } from "../../filesystem/contracts/path.js";
import type { WorkspaceFileSystemLease } from "../../filesystem/runtime.js";

export interface ObservationEntry {
	readonly canonicalPath: string;
	readonly version: ContentVersion;
}

export interface FileObservations {
	remember(ref: AnyPathRef, version: ContentVersion): void;
	get(ref: AnyPathRef): ContentVersion | undefined;
}

/** 会话只保存规范路径和版本，每次调用独立绑定自己的路径引用。 */
export class ObservationStore {
	private readonly observations = new Map<string, ObservationEntry>();
	private disposed = false;

	constructor(initial: readonly ObservationEntry[] = []) {
		for (const observation of initial) this.remember(observation.canonicalPath, observation.version);
	}

	bind(lease: Pick<WorkspaceFileSystemLease, "nativeBridge" | "disposed">): FileObservations {
		const canonicalPath = (ref: AnyPathRef): string | undefined => this.disposed || lease.disposed
			? undefined
			: lease.nativeBridge.getNativeIdentity(ref)?.canonicalPath;
		return {
			remember: (ref, version) => {
				const path = canonicalPath(ref);
				if (path === undefined) return;
				this.remember(path, version);
			},
			get: (ref) => {
				const path = canonicalPath(ref);
				const entry = path === undefined ? undefined : this.observations.get(canonicalKey(path));
				return entry === undefined ? undefined : copyVersion(entry.version);
			},
		};
	}

	entries(): readonly ObservationEntry[] {
		return [...this.observations.values()];
	}

	get size(): number {
		return this.observations.size;
	}

	dispose(): void {
		this.disposed = true;
		this.observations.clear();
	}

	private remember(canonicalPath: string, version: ContentVersion): void {
		this.observations.set(canonicalKey(canonicalPath), { canonicalPath, version: copyVersion(version) });
	}
}

function canonicalKey(canonicalPath: string): string {
	return process.platform === "win32" ? canonicalPath.toLocaleLowerCase() : canonicalPath;
}

function copyVersion(version: ContentVersion): ContentVersion {
	return { hash: version.hash, sizeBytes: version.sizeBytes };
}
