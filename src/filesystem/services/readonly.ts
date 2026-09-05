import type { ContentOperations } from "../contracts/content.js";
import type { DiscoveryOperations } from "../contracts/discovery.js";
import type { MetadataOperations } from "../contracts/metadata.js";
import type { FsOperationContext } from "../contracts/result.js";
import type { VisibilityOperations } from "../contracts/visibility.js";
import type { WorkspaceNamespaceKernel } from "../kernel/namespace.js";
import type { NativeFileSystem } from "../platform/node/native-filesystem.js";
import { WorkspaceContentService } from "./content.js";
import { WorkspaceDiscoveryService } from "./discovery.js";
import { WorkspaceMetadataService } from "./metadata.js";

export interface ReadonlyFileSystemServices {
	readonly metadata: MetadataOperations;
	readonly content: ContentOperations;
	readonly visibility: VisibilityOperations;
	readonly discovery: DiscoveryOperations;
}

interface ReadonlyFileSystemOptions {
	readonly native: NativeFileSystem;
	readonly namespace: WorkspaceNamespaceKernel;
	readonly visibility: VisibilityOperations;
	readonly context: FsOperationContext;
}

/** 一次绑定只读服务的命名空间、策略与取消上下文。 */
export function createReadonlyFileSystemServices(options: ReadonlyFileSystemOptions): ReadonlyFileSystemServices {
	const metadata = new WorkspaceMetadataService(options.native, options.namespace.bridge, options.visibility, options.context);
	return {
		metadata,
		content: new WorkspaceContentService(options.native, options.namespace.bridge, options.context),
		visibility: options.visibility,
		discovery: new WorkspaceDiscoveryService(options, metadata),
	};
}
