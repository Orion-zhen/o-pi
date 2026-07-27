import { createHash } from "node:crypto";

import type {
	MutationOperations,
	MutationOptions,
	MutationReceipt,
	MutationRunResult,
	MutationSnapshot,
	MutationTransform,
} from "./contracts/mutation.js";
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

/** Owns the Node backend, visibility cache, lazy mutation queue, and workspace invocation leases. */
export class FileSystemRuntime {
	private readonly native: NativeFileSystem;
	private readonly visibility: VisibilityService;
	private readonly shutdown = new AbortController();
	private mutationModule?: Promise<MutationModule>;
	private mutationQueue?: InstanceType<MutationModule["MutationQueue"]>;
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
		const ownerSignal = AbortSignal.any(inputSignals);
		const context: FsOperationContext = { signal: ownerSignal };
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
		const readonly = createReadonlyFileSystemServices({
			native: this.native,
			namespace: namespace.value,
			visibilitySnapshot: snapshot,
			ownerSignal,
		});
		const mutations = lazyMutationOperations(async () => {
			if (this.disposed || ownerSignal.aborted) return undefined;
			const module = await this.loadMutationModule();
			if (this.disposed || ownerSignal.aborted) return undefined;
			this.mutationQueue ??= new module.MutationQueue();
			return new module.WorkspaceMutationService({
				native: this.native,
				namespace: namespace.value,
				queue: this.mutationQueue,
				ownerSignal,
				...(options.onCommitted === undefined ? {} : { onCommitted: options.onCommitted }),
			});
		});
		const filesystem: WorkspaceFileSystem = {
			identity: workspaceIdentity(rootIdentity.canonicalPath),
			root: namespace.value.root,
			paths: namespace.value.paths,
			metadata: readonly.metadata,
			content: readonly.content,
			visibility: readonly.visibility,
			traversal: readonly.traversal,
			discovery: readonly.discovery,
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
		this.mutationQueue?.dispose();
		this.visibility.invalidate();
	}

	private loadMutationModule(): Promise<MutationModule> {
		this.mutationModule ??= Promise.all([
			import("./services/mutation.js"),
			import("./platform/node/mutation-queue.js"),
		]).then(([service, queue]) => ({ ...service, ...queue }));
		return this.mutationModule;
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

type MutationModule = typeof import("./services/mutation.js") & typeof import("./platform/node/mutation-queue.js");

function lazyMutationOperations(load: () => Promise<MutationOperations | undefined>): MutationOperations {
	let resolved: MutationOperations | undefined;
	let pending: Promise<MutationOperations | undefined> | undefined;
	const service = (): Promise<MutationOperations | undefined> => pending ??= load().then((value) => {
		resolved = value;
		return value;
	});
	return {
		run<TRejected>(
			target: TargetRef,
			options: MutationOptions,
			transform: (snapshot: MutationSnapshot) => MutationTransform<TRejected> | Promise<MutationTransform<TRejected>>,
			context: FsOperationContext,
		): Promise<FsResult<MutationRunResult<TRejected>>> {
			if (context.signal?.aborted === true) return Promise.resolve(runtimeClosed(target.displayPath));
			if (resolved !== undefined) return resolved.run(target, options, transform, context);
			return service().then((mutations) => mutations === undefined
				? runtimeClosed(target.displayPath)
				: mutations.run(target, options, transform, context));
		},
		overwrite(target, bytes, options, context) {
			if (context.signal?.aborted === true) return Promise.resolve(runtimeClosed(target.displayPath));
			if (resolved !== undefined) return resolved.overwrite(target, bytes, options, context);
			return service().then((mutations) => mutations === undefined
				? runtimeClosed(target.displayPath)
				: mutations.overwrite(target, bytes, options, context));
		},
	};
}

function runtimeClosed(path: string): FsResult<never> {
	return fsFailure({ code: "aborted", message: "Filesystem runtime is shut down.", path });
}
