import type {
	MutationOperations,
	MutationOptions,
	MutationReceipt,
	MutationRunResult,
	MutationSnapshot,
	MutationTransform,
} from "../contracts/mutation.js";
import type { TargetRef } from "../contracts/path.js";
import { fsFailure, fsSuccess, type FsOperationContext, type FsResult } from "../contracts/result.js";
import { mapNativeError } from "../kernel/native-error.js";
import type { NativePathIdentity, WorkspaceNamespaceKernel } from "../kernel/namespace.js";
import type { NativeFileSystem } from "../platform/node/native-filesystem.js";
import { MutationQueue, MutationQueueUnavailableError } from "../platform/node/mutation-queue.js";
import { contentHash } from "./text.js";

export interface WorkspaceMutationServiceOptions {
	readonly native: NativeFileSystem;
	readonly namespace: WorkspaceNamespaceKernel;
	readonly queue?: MutationQueue;
	/** Runs after a successful write and before the target queue is released. */
	readonly onCommitted?: (receipt: MutationReceipt) => void;
}

/** Guarded full-overwrite mutations with process-local serialization and optimistic content checks. */
export class WorkspaceMutationService implements MutationOperations {
	private readonly queue: MutationQueue;

	constructor(private readonly options: WorkspaceMutationServiceOptions) {
		this.queue = options.queue ?? new MutationQueue();
	}

	async run<TRejected>(
		target: TargetRef,
		options: MutationOptions,
		transform: (snapshot: MutationSnapshot) => MutationTransform<TRejected> | Promise<MutationTransform<TRejected>>,
		context: FsOperationContext,
	): Promise<FsResult<MutationRunResult<TRejected>>> {
		const initialIdentity = this.options.namespace.bridge.getNativeIdentity(target);
		if (initialIdentity === undefined) return invalidTarget(target);
		try {
			return await this.queue.run(initialIdentity.canonicalPath, context.signal, async () => {
				const current = await this.prepareTarget(initialIdentity.lexicalPath, target.displayPath, options, context);
				if (!current.ok) return current;
				const snapshot = await this.readSnapshot(current.value.target, current.value.identity, context);
				if (!snapshot.ok) return snapshot;
				if (isAborted(context)) return aborted(target.displayPath);

				const transformed = await transform(cloneSnapshot(snapshot.value));
				if (transformed.type === "reject") {
					return fsSuccess({ committed: false, reason: transformed.reason, snapshot: snapshot.value });
				}
				if (!(transformed.bytes instanceof Uint8Array)) {
					return fsFailure({ code: "invalid-path", message: "Mutation transform returned invalid bytes.", path: target.displayPath });
				}
				const committedBytes = transformed.bytes.slice();
				if (isAborted(context)) return aborted(target.displayPath);

				const finalTarget = await this.resolveTarget(initialIdentity.lexicalPath, context);
				if (!finalTarget.ok) return finalTarget;
				const finalIdentity = this.options.namespace.bridge.getNativeIdentity(finalTarget.value);
				if (finalIdentity === undefined) return invalidTarget(finalTarget.value);
				if (finalIdentity.canonicalPath !== current.value.identity.canonicalPath) {
					return changed(target.displayPath, snapshot.value, undefined);
				}
				const live = await this.readSnapshot(finalTarget.value, finalIdentity, context);
				if (!live.ok) return live;
				if (!sameSnapshot(snapshot.value, live.value)) return changed(target.displayPath, snapshot.value, live.value);
				if (isAborted(context)) return aborted(target.displayPath);

				try {
					// The commit boundary starts here. Cancellation after this point cannot turn a completed write into failure.
					await this.options.native.write(finalIdentity.nativePath, committedBytes);
				} catch (error) {
					const mapped = mapNativeError(error, target.displayPath);
					return fsFailure({ ...mapped, code: "write-failed", message: "File could not be written." });
				}
				const after = versionOf(committedBytes);
				const receipt: MutationReceipt = {
					...after,
					target: finalTarget.value,
					created: !snapshot.value.exists,
					...(snapshot.value.exists ? { before: versionFromSnapshot(snapshot.value) } : {}),
				};
				try {
					this.options.onCommitted?.(receipt);
				} catch {
					// The write is authoritative; owner-state observation is best effort after commit.
				}
				return fsSuccess({ committed: true, receipt });
			});
		} catch (error) {
			if (error instanceof MutationQueueUnavailableError) return aborted(target.displayPath);
			throw error;
		}
	}

	async overwrite(
		target: TargetRef,
		bytes: Uint8Array,
		options: MutationOptions,
		context: FsOperationContext,
	): Promise<FsResult<MutationReceipt>> {
		const result = await this.run<never>(target, options, () => ({ type: "commit", bytes }), context);
		if (!result.ok) return result;
		if (result.value.committed) return fsSuccess(result.value.receipt);
		return fsFailure({ code: "write-failed", message: "Mutation was rejected unexpectedly.", path: target.displayPath });
	}

	private async prepareTarget(
		lexicalPath: string,
		displayPath: string,
		options: MutationOptions,
		context: FsOperationContext,
	): Promise<FsResult<{ readonly target: TargetRef; readonly identity: NativePathIdentity }>> {
		let target = await this.resolveTarget(lexicalPath, context);
		if (!target.ok) return target;
		let identity = this.options.namespace.bridge.getNativeIdentity(target.value);
		if (identity === undefined) return invalidTarget(target.value);
		if (options.createParents) {
			try {
				await this.options.native.mkdir(identity.parentPath, { ...context, recursive: true });
			} catch (error) {
				return fsFailure(mapNativeError(error, displayPath));
			}
			target = await this.resolveTarget(lexicalPath, context);
			if (!target.ok) return target;
			identity = this.options.namespace.bridge.getNativeIdentity(target.value);
			if (identity === undefined) return invalidTarget(target.value);
		}
		return fsSuccess({ target: target.value, identity });
	}

	private async resolveTarget(lexicalPath: string, context: FsOperationContext): Promise<FsResult<TargetRef>> {
		return await this.options.namespace.paths.resolveTarget(lexicalPath, { followExistingSymlink: true }, context);
	}

	private async readSnapshot(
		target: TargetRef,
		identity: NativePathIdentity,
		context: FsOperationContext,
	): Promise<FsResult<MutationSnapshot>> {
		if (target.existingKind === undefined) return fsSuccess({ exists: false });
		if (target.existingKind !== "file") {
			return fsFailure({ code: "not-file", message: "Mutation target is not a regular file.", path: target.displayPath });
		}
		try {
			const bytes = await this.options.native.read(identity.nativePath, context);
			return fsSuccess({ exists: true, bytes, hash: contentHash(bytes), sizeBytes: bytes.byteLength });
		} catch (error) {
			return fsFailure(mapNativeError(error, target.displayPath));
		}
	}
}

function cloneSnapshot(snapshot: MutationSnapshot): MutationSnapshot {
	return snapshot.exists ? { ...snapshot, bytes: snapshot.bytes.slice() } : snapshot;
}

function sameSnapshot(left: MutationSnapshot, right: MutationSnapshot): boolean {
	if (left.exists !== right.exists) return false;
	if (!left.exists || !right.exists) return true;
	return left.hash === right.hash && left.sizeBytes === right.sizeBytes;
}

function versionOf(bytes: Uint8Array): { readonly hash: string; readonly sizeBytes: number } {
	return { hash: contentHash(bytes), sizeBytes: bytes.byteLength };
}

function versionFromSnapshot(snapshot: Extract<MutationSnapshot, { readonly exists: true }>): { readonly hash: string; readonly sizeBytes: number } {
	return { hash: snapshot.hash, sizeBytes: snapshot.sizeBytes };
}

function invalidTarget(target: TargetRef): FsResult<never> {
	return fsFailure({ code: "invalid-path", message: "Mutation target does not belong to this filesystem.", path: target.displayPath });
}

function isAborted(context: FsOperationContext): boolean {
	return context.signal?.aborted === true;
}

function aborted(path: string): FsResult<never> {
	return fsFailure({ code: "aborted", message: "Mutation was aborted.", path });
}

function changed(path: string, expected: MutationSnapshot, actual: MutationSnapshot | undefined): FsResult<never> {
	return fsFailure({
		code: "changed-during-read",
		message: "Mutation target changed before commit.",
		path,
		details: {
			expected: expected.exists ? expected.hash : "missing",
			actual: actual === undefined ? "different-target" : actual.exists ? actual.hash : "missing",
		},
	});
}
