import type {
	CommittedMutation,
	MutationOperations,
	MutationOptions,
	MutationReceipt,
	MutationSnapshot,
	PreparedMutation,
} from "../contracts/mutation.ts";
import type { TargetRef } from "../contracts/path.ts";
import { FileSystemError, fsValue, type FsOperationContext } from "../contracts/result.ts";
import { isNativeError, mapNativeError } from "../kernel/native-error.ts";
import type { NativePathIdentity, ResolvedTargetPath, WorkspaceNamespaceKernel } from "../kernel/namespace.ts";
import type { NativeFileSystem, NativeMetadata } from "../platform/node/native-filesystem.ts";
import { MutationQueue, MutationQueueUnavailableError } from "../platform/node/mutation-queue.ts";
import { readStableFile } from "./content.ts";
import { contentHash } from "./text.ts";

export interface WorkspaceMutationServiceOptions {
	readonly native: NativeFileSystem;
	readonly namespace: WorkspaceNamespaceKernel;
	readonly queue: MutationQueue;
	readonly context: FsOperationContext;
	/** 成功提交后、释放目标队列前记录版本。 */
	readonly onCommitted?: (receipt: MutationReceipt) => void;
}

type PreparedTarget = ResolvedTargetPath & { readonly parentMetadata?: NativeMetadata };

interface SnapshotState {
	readonly snapshot: MutationSnapshot;
	readonly metadata?: NativeMetadata;
}

type PrepareMutation<T> = (snapshot: MutationSnapshot) => PreparedMutation<T> | Promise<PreparedMutation<T>>;
const REKEY = Symbol("rekey");
const MAX_CANONICAL_KEY_ATTEMPTS = 4;

/** 按规范目标串行提交，准备与提交前都重新验证路径和快照。 */
export class WorkspaceMutationService implements MutationOperations {
	constructor(private readonly options: WorkspaceMutationServiceOptions) {}

	async run<T>(target: TargetRef, options: MutationOptions, prepare: PrepareMutation<T>): Promise<CommittedMutation<T>> {
		const initialIdentity = this.options.namespace.bridge.getNativeIdentity(target);
		if (initialIdentity === undefined) {
			throw new FileSystemError({ code: "invalid-path", message: "Mutation target does not belong to this filesystem.", path: target.displayPath });
		}
		try {
			for (let attempt = 0; attempt < MAX_CANONICAL_KEY_ATTEMPTS; attempt += 1) {
				const keyed = await this.prepareTarget(initialIdentity.namespacePath, options.createParents);
				const queueKey = keyed.identity.canonicalPath;
				const committed = await this.options.queue.run(queueKey, this.options.context.signal, async () => {
					const current = await this.prepareTarget(initialIdentity.namespacePath, options.createParents);
					if (!sameNativePath(current.identity.canonicalPath, queueKey)) return REKEY;
					return this.runLocked(current, initialIdentity.namespacePath, options, prepare);
				});
				if (committed !== REKEY) return committed;
			}
			throw new FileSystemError({
				code: "changed-during-read", message: "Mutation target could not be stabilized before locking.",
				path: target.displayPath, details: { expected: "stable-target", actual: "changing-target" },
			});
		} catch (error) {
			if (error instanceof MutationQueueUnavailableError) throw aborted(target.displayPath);
			throw error;
		}
	}

	private async runLocked<T>(
		current: PreparedTarget,
		lexicalPath: string,
		options: MutationOptions,
		prepare: PrepareMutation<T>,
	): Promise<CommittedMutation<T>> {
		const context = this.options.context;
		const parent = current.parentMetadata ?? await this.readParentMetadata(current.identity, current.target.displayPath);
		const { snapshot, metadata } = await this.readSnapshot(current, options.maxSnapshotBytes);
		this.checkAborted(current.target.displayPath);
		const prepared = await prepare(snapshot.exists ? { ...snapshot, bytes: snapshot.bytes.slice() } : snapshot);
		if (options.maxOutputBytes !== undefined && prepared.bytes.byteLength > options.maxOutputBytes) {
			throw new FileSystemError({
				code: "too-large", message: "File exceeds the configured byte limit.", path: current.target.displayPath,
				details: { limit: options.maxOutputBytes, size: prepared.bytes.byteLength },
			});
		}
		const bytes = prepared.bytes.slice();
		this.checkAborted(current.target.displayPath);
		let target: TargetRef;
		try {
			target = await this.options.native.atomicReplace(current.identity.nativePath, bytes, {
				...context,
				...(metadata === undefined ? {} : { mode: metadata.mode }),
				beforeCommit: () => this.validateBeforeCommit(lexicalPath, options, current, parent, snapshot),
			});
		} catch (error) {
			if (error instanceof FileSystemError) throw error;
			const mapped = mapNativeError(error, current.target.displayPath);
			throw new FileSystemError(mapped.code === "aborted" ? mapped : { ...mapped, code: "write-failed", message: "File could not be written." });
		}
		const receipt: MutationReceipt = {
			hash: contentHash(bytes), sizeBytes: bytes.byteLength, target, created: !snapshot.exists,
			...(snapshot.exists ? { before: { hash: snapshot.hash, sizeBytes: snapshot.sizeBytes } } : {}),
		};
		try {
			this.options.onCommitted?.(receipt);
		} catch {
			// 文件已提交，观察回调失败不能改写提交结果。
		}
		return { receipt, prepared: prepared.prepared };
	}

	private async validateBeforeCommit(
		lexicalPath: string,
		options: MutationOptions,
		current: PreparedTarget,
		parentBefore: NativeMetadata,
		snapshot: MutationSnapshot,
	): Promise<TargetRef> {
		this.checkAborted(current.target.displayPath);
		const finalTarget = fsValue(await this.options.namespace.bridge.resolveTargetPath(lexicalPath));
		if (!sameNativePath(finalTarget.identity.canonicalPath, current.identity.canonicalPath)) {
			throw changed(current.target.displayPath, snapshot, undefined);
		}
		const live = await this.readSnapshot(finalTarget, options.maxSnapshotBytes);
		if (!sameSnapshot(snapshot, live.snapshot)) throw changed(current.target.displayPath, snapshot, live.snapshot);
		const parentAfter = await this.readParentMetadata(finalTarget.identity, current.target.displayPath);
		if (parentBefore.kind !== parentAfter.kind || parentBefore.identity !== parentAfter.identity) {
			throw changed(current.target.displayPath, snapshot, undefined);
		}
		this.checkAborted(current.target.displayPath);
		return finalTarget.target;
	}

	private async prepareTarget(lexicalPath: string, createParents: boolean): Promise<PreparedTarget> {
		const context = this.options.context;
		const prepared = fsValue(await this.options.namespace.bridge.resolveTargetPath(lexicalPath));
		if (!createParents) return prepared;
		try {
			const parentMetadata = await this.options.native.lstat(prepared.identity.parentPath, context);
			if (parentMetadata.kind === "directory") return { ...prepared, parentMetadata };
		} catch (error) {
			if (!isNativeError(error, "not-found")) throw new FileSystemError(mapNativeError(error, prepared.target.displayPath));
		}
		try {
			await this.options.native.mkdir(prepared.identity.parentPath, { ...context, recursive: true });
		} catch (error) {
			throw new FileSystemError(mapNativeError(error, prepared.target.displayPath));
		}
		return fsValue(await this.options.namespace.bridge.resolveTargetPath(lexicalPath));
	}

	private async readParentMetadata(identity: NativePathIdentity, displayPath: string): Promise<NativeMetadata> {
		let metadata: NativeMetadata;
		try {
			metadata = await this.options.native.lstat(identity.parentPath, this.options.context);
		} catch (error) {
			throw new FileSystemError(mapNativeError(error, displayPath));
		}
		if (metadata.kind !== "directory") {
			throw new FileSystemError({ code: "not-directory", message: "Writable parent is not a directory.", path: displayPath });
		}
		return metadata;
	}

	private async readSnapshot(target: PreparedTarget, maxBytes: number | undefined): Promise<SnapshotState> {
		if (!("existing" in target)) return { snapshot: { exists: false } };
		if (target.existing.kind !== "file") {
			throw new FileSystemError({ code: "not-file", message: "Mutation target is not a regular file.", path: target.target.displayPath });
		}
		const { bytes, metadata } = fsValue(await readStableFile(
			this.options.native, this.options.namespace.bridge, target.existing, this.options.context,
			maxBytes === undefined ? {} : { maxBytes },
		));
		return { snapshot: { exists: true, bytes, hash: contentHash(bytes), sizeBytes: bytes.byteLength }, metadata };
	}

	private checkAborted(path: string): void {
		if (this.options.context.signal?.aborted) throw aborted(path);
	}
}

function sameSnapshot(left: MutationSnapshot, right: MutationSnapshot): boolean {
	if (left.exists !== right.exists) return false;
	return !left.exists || !right.exists || (left.hash === right.hash && left.sizeBytes === right.sizeBytes);
}

function sameNativePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left === right;
}

function aborted(path: string): FileSystemError {
	return new FileSystemError({ code: "aborted", message: "Mutation was aborted.", path });
}

function changed(path: string, expected: MutationSnapshot, actual: MutationSnapshot | undefined): FileSystemError {
	return new FileSystemError({
		code: "changed-during-read", message: "Mutation target changed before commit.", path,
		details: {
			expected: expected.exists ? expected.hash : "missing",
			actual: actual === undefined ? "different-target" : actual.exists ? actual.hash : "missing",
		},
	});
}
