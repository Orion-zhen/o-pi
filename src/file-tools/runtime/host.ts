import type { FilesystemPathAccess } from "../../filesystem/contracts/access.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import {
	FileSystemRuntime,
	type WorkspaceNativeBridge,
} from "../../filesystem/runtime.js";
import {
	FileToolsConfigProvider,
	type FileToolsConfigLoader,
} from "../config.js";
import { fail, isFailed, mapFsError, type ToolOutcome } from "../shared/result.js";
import type { FileToolLimits } from "../../file-tool-limits.js";
import { ObservationStore, type FileObservations, type ObservationEntry } from "./observation-store.js";
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
	readonly observation: FileObservations;
	readonly context: FsOperationContext;
	/** 供 LSP adapter 使用的组合边界。 */
	readonly nativeBridge: WorkspaceNativeBridge;
	dispose(): void;
}

export interface SessionObservationSeed {
	readonly sessionId: string;
	readonly observations: readonly ObservationEntry[];
}

export interface FileToolsHostOptions {
	readonly config?: FileToolsConfigLoader & { dispose?(): void };
	readonly filesystem?: FileSystemRuntime;
	readonly initialSession?: SessionObservationSeed;
}

/** 统一拥有配置、文件系统、调用租约和会话观测。 */
export class FileToolsHost {
	private readonly config: FileToolsConfigLoader & { dispose?(): void };
	private readonly filesystem: FileSystemRuntime;
	private readonly sessions = new Map<string, ObservationStore>();
	private accepting = true;
	private disposed = false;

	constructor(options: FileToolsHostOptions = {}) {
		this.config = options.config ?? new FileToolsConfigProvider();
		this.filesystem = options.filesystem ?? new FileSystemRuntime();
		if (options.initialSession !== undefined && options.initialSession.observations.length > 0) {
			this.sessions.set(
				options.initialSession.sessionId,
				new ObservationStore(options.initialSession.observations),
			);
		}
	}

	sessionObservations(sessionId: string): readonly ObservationEntry[] {
		return this.sessions.get(sessionId)?.entries() ?? [];
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
				observations: observation.entries(),
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

		let store = this.sessions.get(options.sessionId);
		let createdSession = false;
		if (store === undefined) {
			store = new ObservationStore();
			this.sessions.set(options.sessionId, store);
			createdSession = true;
		}
		let observation: FileObservations;
		const opened = await this.filesystem.open({
			cwd: options.cwd,
			policy: config.value.filesystem,
			...(options.pathAccess === undefined ? {} : { pathAccess: options.pathAccess }),
			...(options.signal === undefined ? {} : { context: { signal: options.signal } }),
			onCommitted: (receipt) => { observation.remember(receipt.target, receipt); },
		});
		if (!opened.ok) {
			if (createdSession && this.sessions.get(options.sessionId) === store) {
				store.dispose();
				this.sessions.delete(options.sessionId);
			}
			return mapFsError(opened.error);
		}
		if (!this.accepting) {
			opened.value.dispose();
			return hostClosed();
		}
		const lease = opened.value;
		observation = store.bind(lease);
		return {
			filesystem: lease.filesystem,
			context: lease.context,
			nativeBridge: lease.nativeBridge,
			limits: Object.freeze(structuredClone(config.value.limits)),
			observation,
			dispose: () => lease.dispose(),
		};
	}

	stop(): void {
		this.accepting = false;
	}

	dispose(): void {
		if (this.disposed) return;
		this.stop();
		this.disposed = true;
		for (const observation of this.sessions.values()) observation.dispose();
		this.sessions.clear();
		this.filesystem.dispose();
		this.config.dispose?.();
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
