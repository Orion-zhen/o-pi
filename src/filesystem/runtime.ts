import { createHash } from "node:crypto";

import type { MutationReceipt } from "./contracts/mutation.js";
import type { ExistingRef, TargetRef } from "./contracts/path.js";
import type { FilesystemPolicy } from "./contracts/policy.js";
import { fsFailure, fsSuccess, type FsOperationContext, type FsResult } from "./contracts/result.js";
import type { VisibilityService } from "./contracts/visibility.js";
import type { WorkspaceFileSystem, WorkspaceIdentity } from "./contracts/workspace.js";
import { mapNativeError } from "./kernel/native-error.js";
import {
	createWorkspaceNamespace,
	type NativePathIdentity,
} from "./kernel/namespace.js";
import { NodeNativeFileSystem, type NativeFileSystem } from "./platform/node/native-filesystem.js";
import { MutationQueue } from "./platform/node/mutation-queue.js";
import { WorkspaceMutationService } from "./services/mutation.js";
import { createReadonlyFileSystemServices } from "./services/readonly.js";
import { WorkspaceVisibilityService } from "./services/visibility/service.js";

export interface WorkspaceNativeBridge {
	getNativeIdentity(ref: ExistingRef | TargetRef): NativePathIdentity | undefined;
}

export interface OpenWorkspaceOptions {
	readonly cwd: string;
	readonly policy: FilesystemPolicy;
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

export interface FileSystemRuntimeOptions {
	readonly native?: NativeFileSystem;
	readonly visibility?: VisibilityService;
}

/** Owns the Node backend, visibility cache, mutation queue, and workspace invocation leases. */
export class FileSystemRuntime {
	private readonly native: NativeFileSystem;
	private readonly visibility: VisibilityService;
	private readonly queue = new MutationQueue();
	private readonly shutdown = new AbortController();
	private readonly leases = new Set<WorkspaceLease>();
	private disposed = false;

	constructor(options: FileSystemRuntimeOptions = {}) {
		this.native = options.native ?? new NodeNativeFileSystem();
		this.visibility = options.visibility ?? new WorkspaceVisibilityService(this.native);
	}

	async open(options: OpenWorkspaceOptions): Promise<FsResult<WorkspaceFileSystemLease>> {
		if (this.disposed) return runtimeClosed(options.cwd);
		const leaseController = new AbortController();
		const inputSignals = [this.shutdown.signal, leaseController.signal];
		if (options.context?.signal !== undefined) inputSignals.push(options.context.signal);
		const context: FsOperationContext = { signal: AbortSignal.any(inputSignals) };
		const namespace = await createWorkspaceNamespace({
			workspaceRoot: options.cwd,
			blockedPaths: options.policy.blockedPaths,
			native: this.native,
			context,
		});
		if (!namespace.ok) return namespace;
		const rootIdentity = namespace.value.bridge.getNativeIdentity(namespace.value.root);
		if (rootIdentity === undefined) {
			return fsFailure({ code: "invalid-path", message: "Workspace root identity is unavailable.", path: options.cwd });
		}
		let snapshot;
		try {
			snapshot = await this.visibility.createSnapshot(rootIdentity.canonicalPath, options.policy.visibility, context);
		} catch (error) {
			return fsFailure(mapNativeError(error, namespace.value.root.displayPath));
		}
		if (this.disposed || context.signal?.aborted === true) return runtimeClosed(options.cwd);
		const readonly = createReadonlyFileSystemServices({ native: this.native, namespace: namespace.value, visibilitySnapshot: snapshot });
		const mutations = new WorkspaceMutationService({
			native: this.native,
			namespace: namespace.value,
			queue: this.queue,
			...(options.onCommitted === undefined ? {} : { onCommitted: options.onCommitted }),
		});
		const filesystem: WorkspaceFileSystem = {
			identity: workspaceIdentity(rootIdentity.canonicalPath),
			root: namespace.value.root,
			paths: namespace.value.paths,
			metadata: readonly.metadata,
			content: readonly.content,
			visibility: readonly.visibility,
			traversal: readonly.traversal,
			mutations,
			catalog: readonly.catalog,
		};
		const nativeBridge: WorkspaceNativeBridge = {
			getNativeIdentity: (ref) => namespace.value.bridge.getNativeIdentity(ref),
		};
		const lease = new WorkspaceLease(filesystem, context, nativeBridge, leaseController, () => this.leases.delete(lease));
		this.leases.add(lease);
		return fsSuccess(lease);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.shutdown.abort(new Error("Filesystem runtime is shut down."));
		for (const lease of [...this.leases]) lease.dispose();
		this.queue.dispose();
		this.visibility.invalidate();
	}
}

class WorkspaceLease implements WorkspaceFileSystemLease {
	private isDisposed = false;

	constructor(
		readonly filesystem: WorkspaceFileSystem,
		readonly context: FsOperationContext,
		readonly nativeBridge: WorkspaceNativeBridge,
		private readonly controller: AbortController,
		private readonly onDispose: () => void,
	) {}

	get disposed(): boolean {
		return this.isDisposed;
	}

	dispose(): void {
		if (this.isDisposed) return;
		this.isDisposed = true;
		this.controller.abort(new Error("Workspace filesystem lease is closed."));
		this.onDispose();
	}
}

function workspaceIdentity(canonicalRoot: string): WorkspaceIdentity {
	return `workspace:${createHash("sha256").update(canonicalRoot).digest("hex")}` as WorkspaceIdentity;
}

function runtimeClosed(path: string): FsResult<never> {
	return fsFailure({ code: "aborted", message: "Filesystem runtime is shut down.", path });
}
