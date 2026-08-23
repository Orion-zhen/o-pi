import type { FilesystemPathAccess } from "../../filesystem/contracts/access.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import {
	FileSystemRuntime,
	type WorkspaceFileSystemLease,
	type WorkspaceNativeBridge,
} from "../../filesystem/runtime.js";
import {
	FileToolsConfigProvider,
	type FileToolsConfigLoader,
} from "../config.js";
import { fail, isFailed, mapFsError, type ToolOutcome } from "../shared/result.js";
import type { FileToolLimits } from "../../file-tool-limits.js";
import { ObservationStore } from "./observation-store.js";
import {
	createSessionMutationScope,
	type SessionMutationScope,
} from "./session-mutation.js";

export interface FileToolsHostOpenOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly signal?: AbortSignal;
	readonly pathAccess?: FilesystemPathAccess;
}

export interface FileToolsInvocation {
	readonly filesystem: WorkspaceFileSystem;
	readonly limits: Readonly<FileToolLimits>;
	readonly observation: ObservationStore;
	readonly context: FsOperationContext;
	/** 供 LSP adapter 使用的组合边界。 */
	readonly nativeBridge: WorkspaceNativeBridge;
	readonly disposed: boolean;
	dispose(): void;
}

export interface FileToolsHostOptions {
	readonly config?: FileToolsConfigLoader & { dispose?(): void };
	readonly filesystem?: FileSystemRuntime;
}

/** Composition owner for config, filesystem runtime, invocation leases, and session observations. */
export class FileToolsHost {
	private readonly config: FileToolsConfigLoader & { dispose?(): void };
	private readonly filesystem: FileSystemRuntime;
	private readonly sessions = new Map<string, ObservationStore>();
	private readonly invocations = new Set<HostInvocation>();
	private accepting = true;
	private disposed = false;

	constructor(options: FileToolsHostOptions = {}) {
		this.config = options.config ?? new FileToolsConfigProvider();
		this.filesystem = options.filesystem ?? new FileSystemRuntime();
	}

	async beginSessionMutation(options: FileToolsHostOpenOptions): Promise<SessionMutationScope | undefined> {
		const observation = this.sessions.get(options.sessionId);
		if (observation === undefined || observation.size === 0) return undefined;
		const opened = await this.open(options);
		if (isFailed(opened)) return undefined;
		try {
			return await createSessionMutationScope({
				filesystem: opened.filesystem,
				observation: opened.observation,
				maxFileBytes: Math.max(
					opened.limits.read_max_file_bytes,
					opened.limits.write_max_file_bytes,
					opened.limits.edit_max_file_bytes,
				),
				dispose: () => opened.dispose(),
			});
		} catch (error) {
			opened.dispose();
			throw error;
		}
	}

	async open(options: FileToolsHostOpenOptions): Promise<ToolOutcome<FileToolsInvocation>> {
		if (!this.accepting) return hostClosed();
		if (isAborted(options.signal)) return operationAborted();

		const config = await this.config.load(options.cwd);
		if (!this.accepting) return hostClosed();
		if (!config.ok) return fail("CONFIG_ERROR", config.error.message, config.error.details === undefined ? {} : { details: config.error.details });
		if (isAborted(options.signal)) return operationAborted();

		let observation = this.sessions.get(options.sessionId);
		let createdSession = false;
		if (observation === undefined) {
			observation = new ObservationStore();
			this.sessions.set(options.sessionId, observation);
			createdSession = true;
		}
		const opened = await this.filesystem.open({
			cwd: options.cwd,
			policy: config.value.filesystem,
			...(options.pathAccess === undefined ? {} : { pathAccess: options.pathAccess }),
			...(options.signal === undefined ? {} : { context: { signal: options.signal } }),
			onCommitted: (receipt) => { observation?.remember(receipt.target, receipt); },
		});
		if (!opened.ok) {
			if (createdSession && this.sessions.get(options.sessionId) === observation) {
				observation.dispose();
				this.sessions.delete(options.sessionId);
			}
			return mapFsError(opened.error);
		}
		if (!this.accepting) {
			opened.value.dispose();
			return hostClosed();
		}
		const detachObservation = observation.attach(opened.value.nativeBridge);
		let invocation: HostInvocation;
		invocation = new HostInvocation(
			opened.value,
			Object.freeze(structuredClone(config.value.limits)),
			observation,
			detachObservation,
			() => this.invocations.delete(invocation),
		);
		this.invocations.add(invocation);
		return invocation;
	}

	stop(): void {
		this.accepting = false;
	}

	dispose(): void {
		if (this.disposed) return;
		this.stop();
		this.disposed = true;
		for (const invocation of [...this.invocations]) invocation.dispose();
		for (const observation of this.sessions.values()) observation.dispose();
		this.sessions.clear();
		this.filesystem.dispose();
		this.config.dispose?.();
	}
}

class HostInvocation implements FileToolsInvocation {
	private isDisposed = false;

	constructor(
		private readonly lease: WorkspaceFileSystemLease,
		readonly limits: Readonly<FileToolLimits>,
		readonly observation: ObservationStore,
		private readonly detachObservation: () => void,
		private readonly onDispose: () => void,
	) {}

	get filesystem(): WorkspaceFileSystem {
		return this.lease.filesystem;
	}

	get context(): FsOperationContext {
		return this.lease.context;
	}

	get nativeBridge(): WorkspaceNativeBridge {
		return this.lease.nativeBridge;
	}

	get disposed(): boolean {
		return this.isDisposed;
	}

	dispose(): void {
		if (this.isDisposed) return;
		this.isDisposed = true;
		this.detachObservation();
		this.lease.dispose();
		this.onDispose();
	}
}

function hostClosed(): ReturnType<typeof fail> {
	return fail("OPERATION_ABORTED", "File-tools host is shut down.");
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function operationAborted(): ReturnType<typeof fail> {
	return fail("OPERATION_ABORTED", "Operation aborted.");
}
