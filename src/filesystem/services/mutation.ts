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
import { isNativeError, mapNativeError } from "../kernel/native-error.js";
import type { NativePathIdentity, ResolvedTargetPath, WorkspaceNamespaceKernel } from "../kernel/namespace.js";
import {
	NativeFileSystemError,
	type NativeFileSystem,
	type NativeMetadata,
} from "../platform/node/native-filesystem.js";
import { MutationQueue, MutationQueueUnavailableError } from "../platform/node/mutation-queue.js";
import { readStableFile } from "./content.js";
import { contentHash } from "./text.js";

export interface WorkspaceMutationServiceOptions {
	readonly native: NativeFileSystem;
	readonly namespace: WorkspaceNamespaceKernel;
	readonly queue: MutationQueue;
	readonly context: FsOperationContext;
	/** Runs after a successful write and before the target queue is released. */
	readonly onCommitted?: (receipt: MutationReceipt) => void;
}

type PreparedTarget = ResolvedTargetPath & { readonly parentMetadata?: NativeMetadata };

interface SnapshotState {
	readonly snapshot: MutationSnapshot;
	readonly metadata?: NativeMetadata;
}

const REKEY = Symbol("rekey");
const MAX_CANONICAL_KEY_ATTEMPTS = 4;

/** Guarded atomic replacements with canonical-target serialization and optimistic checks. */
export class WorkspaceMutationService implements MutationOperations {
	constructor(private readonly options: WorkspaceMutationServiceOptions) {}

	async run<TPrepared, TRejected = never>(
		target: TargetRef,
		options: MutationOptions,
		transform: (snapshot: MutationSnapshot) => MutationTransform<TPrepared, TRejected> | Promise<MutationTransform<TPrepared, TRejected>>,
	): Promise<FsResult<MutationRunResult<TPrepared, TRejected>>> {
		const context = this.options.context;
		const initialIdentity = this.options.namespace.bridge.getNativeIdentity(target);
		if (initialIdentity === undefined) return invalidTarget(target);

		try {
			for (let attempt = 0; attempt < MAX_CANONICAL_KEY_ATTEMPTS; attempt += 1) {
				const keyed = await this.prepareTarget(initialIdentity.namespacePath, options.createParents);
				if (!keyed.ok) return keyed;
				const queueKey = keyed.value.identity.canonicalPath;
				const queued = await this.options.queue.run(queueKey, context.signal, async () => {
					const current = await this.prepareTarget(initialIdentity.namespacePath, options.createParents);
					if (!current.ok) return current;
					if (!sameNativePath(current.value.identity.canonicalPath, queueKey)) return REKEY;
					return await this.runLocked(current.value, initialIdentity.namespacePath, options, transform);
				});
				if (queued === REKEY) continue;
				return queued;
			}
			return unstableCanonicalTarget(target.displayPath);
		} catch (error) {
			if (error instanceof MutationQueueUnavailableError) return aborted(target.displayPath);
			throw error;
		}
	}

	private async runLocked<TPrepared, TRejected>(
		current: PreparedTarget,
		lexicalPath: string,
		options: MutationOptions,
		transform: (snapshot: MutationSnapshot) => MutationTransform<TPrepared, TRejected> | Promise<MutationTransform<TPrepared, TRejected>>,
	): Promise<FsResult<MutationRunResult<TPrepared, TRejected>>> {
		const context = this.options.context;
		const parent = current.parentMetadata === undefined
			? await this.readParentMetadata(current.identity, current.target.displayPath)
			: fsSuccess(current.parentMetadata);
		if (!parent.ok) return parent;
		const snapshotState = await this.readSnapshot(current, options.maxSnapshotBytes);
		if (!snapshotState.ok) return snapshotState;
		const snapshot = snapshotState.value.snapshot;
		if (isAborted(context)) return aborted(current.target.displayPath);

		const transformed = await transform(cloneSnapshot(snapshot));
		if (transformed.type === "reject") {
			return fsSuccess({ committed: false, reason: transformed.reason, snapshot });
		}
		if (options.maxOutputBytes !== undefined && transformed.bytes.byteLength > options.maxOutputBytes) {
			return tooLarge(current.target.displayPath, options.maxOutputBytes, transformed.bytes.byteLength);
		}
		const committedBytes = transformed.bytes.slice();
		if (isAborted(context)) return aborted(current.target.displayPath);

		let validationFailure: FsResult<never> | undefined;
		let committedTarget: TargetRef;
		try {
			committedTarget = await this.options.native.atomicReplace(current.identity.nativePath, committedBytes, {
				...context,
				...(snapshotState.value.metadata === undefined ? {} : { mode: snapshotState.value.metadata.mode }),
				beforeCommit: async () => {
					const validation = await this.validateBeforeCommit(
						lexicalPath,
						options,
						current,
						parent.value,
						snapshot,
					);
					if (!validation.ok) {
						validationFailure = validation;
						throw new NativeFileSystemError("changed", "validate-before-commit", current.identity.nativePath);
					}
					return validation.value;
				},
			});
		} catch (error) {
			if (validationFailure !== undefined) return validationFailure;
			const mapped = mapNativeError(error, current.target.displayPath);
			if (mapped.code === "aborted") return fsFailure(mapped);
			return fsFailure({ ...mapped, code: "write-failed", message: "File could not be written." });
		}
		const after = versionOf(committedBytes);
		const receipt: MutationReceipt = {
			...after,
			target: committedTarget,
			created: !snapshot.exists,
			...(snapshot.exists ? { before: versionFromSnapshot(snapshot) } : {}),
		};
		try {
			this.options.onCommitted?.(receipt);
		} catch {
			// The rename is authoritative; owner-state observation is best effort after commit.
		}
		return fsSuccess({ committed: true, receipt, prepared: transformed.prepared });
	}

	private async validateBeforeCommit(
		lexicalPath: string,
		options: MutationOptions,
		current: PreparedTarget,
		parentBefore: NativeMetadata,
		snapshot: MutationSnapshot,
	): Promise<FsResult<TargetRef>> {
		const context = this.options.context;
		if (isAborted(context)) return aborted(current.target.displayPath);
		const finalTarget = await this.options.namespace.bridge.resolveTargetPath(lexicalPath);
		if (!finalTarget.ok) return finalTarget;
		if (!sameNativePath(finalTarget.value.identity.canonicalPath, current.identity.canonicalPath)) {
			return changed(current.target.displayPath, snapshot, undefined);
		}
		const live = await this.readSnapshot(finalTarget.value, options.maxSnapshotBytes);
		if (!live.ok) return live;
		if (!sameSnapshot(snapshot, live.value.snapshot)) {
			return changed(current.target.displayPath, snapshot, live.value.snapshot);
		}
		const parentAfter = await this.readParentMetadata(finalTarget.value.identity, current.target.displayPath);
		if (!parentAfter.ok) return parentAfter;
		if (!sameIdentity(parentBefore, parentAfter.value)) {
			return changed(current.target.displayPath, snapshot, undefined);
		}
		if (isAborted(context)) return aborted(current.target.displayPath);
		return fsSuccess(finalTarget.value.target);
	}

	private async prepareTarget(
		lexicalPath: string,
		createParents: boolean,
	): Promise<FsResult<PreparedTarget>> {
		const context = this.options.context;
		const prepared = await this.options.namespace.bridge.resolveTargetPath(lexicalPath);
		if (!prepared.ok || !createParents) return prepared;
		try {
			const parentMetadata = await this.options.native.lstat(prepared.value.identity.parentPath, context);
			if (parentMetadata.kind === "directory") return fsSuccess({ ...prepared.value, parentMetadata });
		} catch (error) {
			if (!isNativeError(error, "not-found")) {
				return fsFailure(mapNativeError(error, prepared.value.target.displayPath));
			}
		}
		try {
			await this.options.native.mkdir(prepared.value.identity.parentPath, { ...context, recursive: true });
		} catch (error) {
			return fsFailure(mapNativeError(error, prepared.value.target.displayPath));
		}
		return await this.options.namespace.bridge.resolveTargetPath(lexicalPath);
	}

	private async readParentMetadata(
		identity: NativePathIdentity,
		displayPath: string,
	): Promise<FsResult<NativeMetadata>> {
		const context = this.options.context;
		try {
			const metadata = await this.options.native.lstat(identity.parentPath, context);
			if (metadata.kind !== "directory") {
				return fsFailure({ code: "not-directory", message: "Writable parent is not a directory.", path: displayPath });
			}
			return fsSuccess(metadata);
		} catch (error) {
			return fsFailure(mapNativeError(error, displayPath));
		}
	}

	private async readSnapshot(
		target: PreparedTarget,
		maxBytes: number | undefined,
	): Promise<FsResult<SnapshotState>> {
		if (!("existing" in target)) return fsSuccess({ snapshot: { exists: false } });
		if (target.existing.kind !== "file") {
			return fsFailure({ code: "not-file", message: "Mutation target is not a regular file.", path: target.target.displayPath });
		}
		const loaded = await readStableFile(
			this.options.native,
			this.options.namespace.bridge,
			target.existing,
			this.options.context,
			maxBytes === undefined ? {} : { maxBytes },
		);
		if (!loaded.ok) return loaded;
		const { bytes, metadata } = loaded.value;
		return fsSuccess({
			snapshot: { exists: true, bytes, hash: contentHash(bytes), sizeBytes: bytes.byteLength },
			metadata,
		});
	}
}

function tooLarge(path: string, limit: number, size: number): FsResult<never> {
	return fsFailure({
		code: "too-large",
		message: "File exceeds the configured byte limit.",
		path,
		details: { limit, size },
	});
}

function cloneSnapshot(snapshot: MutationSnapshot): MutationSnapshot {
	return snapshot.exists ? { ...snapshot, bytes: snapshot.bytes.slice() } : snapshot;
}

function sameSnapshot(left: MutationSnapshot, right: MutationSnapshot): boolean {
	if (left.exists !== right.exists) return false;
	if (!left.exists || !right.exists) return true;
	return left.hash === right.hash && left.sizeBytes === right.sizeBytes;
}

function sameIdentity(left: NativeMetadata, right: NativeMetadata): boolean {
	return left.kind === right.kind && left.identity === right.identity;
}

function sameNativePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left === right;
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

function unstableCanonicalTarget(path: string): FsResult<never> {
	return fsFailure({
		code: "changed-during-read",
		message: "Mutation target could not be stabilized before locking.",
		path,
		details: { expected: "stable-target", actual: "changing-target" },
	});
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
