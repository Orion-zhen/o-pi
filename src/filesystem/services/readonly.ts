import type { PathCatalogOperations } from "../contracts/catalog.js";
import type { ContentOperations } from "../contracts/content.js";
import type { DiscoveryOperations } from "../contracts/discovery.js";
import type { MetadataOperations } from "../contracts/metadata.js";
import type { TraversalOperations } from "../contracts/traversal.js";
import type { FsOperationContext } from "../contracts/result.js";
import type { VisibilityOperations } from "../contracts/visibility.js";
import type { WorkspaceNamespaceKernel } from "../kernel/namespace.js";
import type { NativeFileSystem } from "../platform/node/native-filesystem.js";
import { WorkspaceContentService } from "./content.js";
import { WorkspaceDiscoveryService } from "./discovery.js";
import { WorkspaceMetadataService } from "./metadata.js";
import { WorkspacePathCatalog } from "./path-catalog.js";
import { WorkspaceTraversalService } from "./traversal.js";

export interface ReadonlyFileSystemServices {
	readonly metadata: MetadataOperations;
	readonly content: ContentOperations;
	readonly visibility: VisibilityOperations;
	readonly traversal: TraversalOperations;
	readonly discovery: DiscoveryOperations;
	readonly catalog: PathCatalogOperations;
}

/** Composes the readonly data plane bound to one namespace and visibility evaluator. */
interface ReadonlyFileSystemOptions {
	readonly native: NativeFileSystem;
	readonly namespace: WorkspaceNamespaceKernel;
	readonly visibility: VisibilityOperations;
	readonly context: FsOperationContext;
}

export function createReadonlyFileSystemServices(options: ReadonlyFileSystemOptions): ReadonlyFileSystemServices {
	const metadata = new WorkspaceMetadataService(
		options.native,
		options.namespace.bridge,
		options.visibility,
		options.context,
	);
	const traversal = new WorkspaceTraversalService(
		options.native,
		options.namespace.bridge,
		options.visibility,
		options.context,
	);
	return {
		metadata,
		content: new WorkspaceContentService(options.native, options.namespace.bridge, options.context),
		visibility: options.visibility,
		traversal,
		discovery: new WorkspaceDiscoveryService(
			options.namespace,
			metadata,
			options.visibility,
			traversal,
			options.context,
		),
		catalog: new WorkspacePathCatalog(traversal, options.context),
	};
}
