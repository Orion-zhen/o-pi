import type { FilesystemPathAccess } from "./contracts/access.ts";
import type { MutationReceipt } from "./contracts/mutation.ts";
import type { ExistingRef, TargetRef } from "./contracts/path.ts";
import type { FilesystemPolicy } from "./contracts/policy.ts";
import { fsFailure, fsSuccess, type FsOperationContext, type FsResult } from "./contracts/result.ts";
import type { WorkspaceFileSystem, WorkspaceIdentity } from "./contracts/workspace.ts";
import { mapNativeError } from "./kernel/native-error.ts";
import { createWorkspaceNamespace, type NativePathIdentity } from "./kernel/namespace.ts";
import { NodeNativeFileSystem, type NativeFileSystem } from "./platform/node/native-filesystem.ts";
import { MutationQueue } from "./platform/node/mutation-queue.ts";
import { WorkspaceContentService } from "./services/content.ts";
import { WorkspaceDiscoveryService } from "./services/discovery.ts";
import { WorkspaceMetadataService } from "./services/metadata.ts";
import { WorkspaceMutationService } from "./services/mutation.ts";
import { WorkspaceVisibilityService } from "./services/visibility/service.ts";

export interface WorkspaceNativeBridge {
	readonly root: NativePathIdentity;
	getNativeIdentity(ref: ExistingRef | TargetRef): NativePathIdentity | undefined;
}

export interface OpenWorkspaceOptions {
	readonly cwd: string;
	readonly policy: FilesystemPolicy;
	readonly pathAccess?: FilesystemPathAccess;
	readonly context?: FsOperationContext;
	readonly onCommitted?: (receipt: MutationReceipt) => void;
}

export interface WorkspaceFileSystemLease {
	readonly filesystem: WorkspaceFileSystem;
	readonly context: FsOperationContext;
	readonly nativeBridge: WorkspaceNativeBridge;
	readonly disposed: boolean;
	dispose(): void;
}

/** 共享可见性缓存和写队列，每次调用绑定独立的取消信号。 */
export class FileSystemRuntime {
	private readonly native: NativeFileSystem;
	private readonly visibility: WorkspaceVisibilityService;
	private readonly shutdown = new AbortController();
	private readonly mutationQueue = new MutationQueue();

	constructor(options: { native?: NativeFileSystem } = {}) {
		this.native = options.native ?? new NodeNativeFileSystem();
		this.visibility = new WorkspaceVisibilityService(this.native);
	}

	async open(options: OpenWorkspaceOptions): Promise<FsResult<WorkspaceFileSystemLease>> {
		const controller = new AbortController();
		const owner = this.shutdown.signal;
		const signals = [owner, controller.signal];
		if (options.context?.signal) signals.push(options.context.signal);
		const signal = AbortSignal.any(signals);
		const context: FsOperationContext = { signal };
		if (signal.aborted) return runtimeClosed(options.cwd);
		const resolved = await createWorkspaceNamespace({
			workspaceRoot: options.cwd,
			blockedPaths: options.policy.blockedPaths,
			...(options.pathAccess === undefined ? {} : { pathAccess: options.pathAccess }),
			native: this.native,
			context,
		});
		if (!resolved.ok) return resolved;
		const namespace = resolved.value;
		try {
			const visibility = await this.visibility.createOperations(
				namespace.rootIdentity.canonicalPath, options.policy.visibility, namespace, context,
			);
			if (signal.aborted) return runtimeClosed(options.cwd);
			const metadata = new WorkspaceMetadataService(this.native, namespace.bridge, visibility, context);
			return fsSuccess({
				filesystem: {
					identity: namespace.rootIdentity.canonicalPath as WorkspaceIdentity,
					root: namespace.root,
					paths: namespace.paths,
					metadata,
					content: new WorkspaceContentService(this.native, namespace.bridge, context),
					visibility,
					discovery: new WorkspaceDiscoveryService({ native: this.native, namespace, visibility, context }, metadata),
					mutations: new WorkspaceMutationService({
						native: this.native, namespace, queue: this.mutationQueue, context,
						...(options.onCommitted === undefined ? {} : { onCommitted: options.onCommitted }),
					}),
				},
				context,
				nativeBridge: { root: namespace.rootIdentity, getNativeIdentity: (ref) => namespace.bridge.getNativeIdentity(ref) },
				get disposed() { return controller.signal.aborted || owner.aborted; },
				dispose: () => controller.abort(new Error("Workspace filesystem lease is closed.")),
			});
		} catch (error) {
			return fsFailure(mapNativeError(error, namespace.root.displayPath));
		}
	}

	dispose(): void {
		if (this.shutdown.signal.aborted) return;
		this.shutdown.abort(new Error("Filesystem runtime is shut down."));
		this.mutationQueue.dispose();
		this.visibility.dispose();
	}
}

function runtimeClosed(path: string): FsResult<never> {
	return fsFailure({ code: "aborted", message: "Filesystem runtime is shut down.", path });
}
