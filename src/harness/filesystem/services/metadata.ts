import type {
	DirectoryEntry,
	FileMetadata,
	MetadataOperations,
} from "../contracts/metadata.js";
import type { DirectoryRef, ExistingRef } from "../contracts/path.js";
import { fsFailure, fsSuccess, type FsOperationContext, type FsResult } from "../contracts/result.js";
import { mapNativeError } from "../kernel/native-error.js";
import type { WorkspaceNamespaceBridge } from "../kernel/namespace.js";
import type { NativeFileSystem } from "../platform/node/native-filesystem.js";
import type { VisibilityOperations } from "../contracts/visibility.js";
import { DIRECTORY_ENTRY_CONCURRENCY } from "./concurrency.js";
import { compareLogicalPath } from "./path-order.js";
import { nativeIdentity } from "./ref.js";

/** Metadata and non-recursive enumeration over guarded refs. */
export class WorkspaceMetadataService implements MetadataOperations {
	constructor(
		private readonly native: NativeFileSystem,
		private readonly bridge: WorkspaceNamespaceBridge,
		private readonly visibility: VisibilityOperations,
		private readonly context: FsOperationContext,
	) {}

	async stat(ref: ExistingRef): Promise<FsResult<FileMetadata>> {
		const context = this.context;
		const identity = nativeIdentity(this.bridge, ref);
		if (!identity.ok) return identity;
		try {
			const metadata = ref.kind === "symlink"
				? await this.native.lstat(identity.value.lexicalPath, context)
				: await this.native.stat(identity.value.nativePath, context);
			return fsSuccess(metadata);
		} catch (error) {
			return fsFailure(mapNativeError(error, ref.displayPath));
		}
	}

	async list(directory: DirectoryRef): Promise<FsResult<readonly DirectoryEntry[]>> {
		const context = this.context;
		const identity = nativeIdentity(this.bridge, directory);
		if (!identity.ok) return identity;
		let nativeEntries;
		try {
			nativeEntries = await this.native.readdir(identity.value.nativePath, context);
		} catch (error) {
			return fsFailure(mapNativeError(error, directory.displayPath));
		}
		const preparedVisibility = await this.visibility.prepareDirectory(directory, nativeEntries);
		if (!preparedVisibility.ok) return preparedVisibility;

		const entries: DirectoryEntry[] = [];
		const sorted = [...nativeEntries].sort((left, right) => compareLogicalPath(left.name, right.name));
		for (let start = 0; start < sorted.length; start += DIRECTORY_ENTRY_CONCURRENCY) {
			const batch = sorted.slice(start, start + DIRECTORY_ENTRY_CONCURRENCY);
			const children = await Promise.all(batch.map(async (entry) => ({
				entry,
				resolved: await this.bridge.resolveChild(directory, entry.name),
			})));
			for (const { entry: nativeEntry, resolved: child } of children) {
				if (!child.ok) {
					if (child.error.code === "aborted") return child;
					// Blocked, raced, or inaccessible children are not exposed by directory listing.
					continue;
				}
				const ref = child.value.ref;
				let linkTarget: string | undefined;
				if (ref.kind === "symlink") {
					try {
						linkTarget = await this.native.readlink(child.value.identity.lexicalPath, context);
					} catch (error) {
						const mapped = mapNativeError(error, ref.displayPath);
						if (mapped.code === "aborted") return fsFailure(mapped);
					}
				}
				entries.push({ ref, name: nativeEntry.name, ...(linkTarget === undefined ? {} : { linkTarget }) });
			}
		}
		return fsSuccess(entries);
	}
}
