import type { PathCatalogOperations } from "../contracts/catalog.js";
import type { ContentOperations } from "../contracts/content.js";
import type { MetadataOperations } from "../contracts/metadata.js";
import type { TraversalOperations } from "../contracts/traversal.js";
import type { VisibilityOperations, VisibilitySnapshot } from "../contracts/visibility.js";
import type { WorkspaceNamespaceKernel } from "../kernel/namespace.js";
import type { NativeFileSystem } from "../platform/node/native-filesystem.js";
import { WorkspaceContentService } from "./content.js";
import { WorkspaceMetadataService } from "./metadata.js";
import { WorkspacePathCatalog } from "./path-catalog.js";
import { WorkspaceTraversalService } from "./traversal.js";
import { SnapshotVisibilityOperations } from "./visibility/operations.js";

export interface ReadonlyFileSystemServices {
	readonly metadata: MetadataOperations;
	readonly content: ContentOperations;
	readonly visibility: VisibilityOperations;
	readonly traversal: TraversalOperations;
	readonly catalog: PathCatalogOperations;
}

/** Composes the readonly data plane bound to one namespace and visibility snapshot. */
export function createReadonlyFileSystemServices(options: {
	readonly native: NativeFileSystem;
	readonly namespace: WorkspaceNamespaceKernel;
	readonly visibilitySnapshot: VisibilitySnapshot;
}): ReadonlyFileSystemServices {
	const visibility = new SnapshotVisibilityOperations(options.visibilitySnapshot, options.namespace.bridge);
	const traversal = new WorkspaceTraversalService(options.native, options.namespace.bridge, visibility);
	return {
		metadata: new WorkspaceMetadataService(options.native, options.namespace.bridge),
		content: new WorkspaceContentService(options.native, options.namespace.bridge),
		visibility,
		traversal,
		catalog: new WorkspacePathCatalog(traversal),
	};
}
