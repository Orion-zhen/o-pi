import type { ContentVersion } from "./content.js";
import type { TargetRef } from "./path.js";
import type { FsResult } from "./result.js";

export type MutationSnapshot =
	| { readonly exists: false }
	| { readonly exists: true; readonly bytes: Uint8Array; readonly hash: string; readonly sizeBytes: number };

export type MutationTransform<TRejected> =
	| { readonly type: "commit"; readonly bytes: Uint8Array }
	| { readonly type: "reject"; readonly reason: TRejected };

export interface MutationReceipt extends ContentVersion {
	readonly before?: ContentVersion;
	readonly created: boolean;
	/** Destination identity revalidated immediately before commit. */
	readonly target: TargetRef;
}

export type MutationRunResult<TRejected> =
	| { readonly committed: true; readonly receipt: MutationReceipt }
	| { readonly committed: false; readonly reason: TRejected; readonly snapshot: MutationSnapshot };

export interface MutationOptions {
	readonly createParents: boolean;
	readonly maxSnapshotBytes?: number;
	readonly maxOutputBytes?: number;
}

export interface MutationOperations {
	run<TRejected>(
		target: TargetRef,
		options: MutationOptions,
		transform: (snapshot: MutationSnapshot) => MutationTransform<TRejected> | Promise<MutationTransform<TRejected>>,
	): Promise<FsResult<MutationRunResult<TRejected>>>;
}
