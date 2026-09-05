import type { ContentVersion } from "./content.js";
import type { TargetRef } from "./path.js";
import type { FsResult } from "./result.js";

export type MutationSnapshot =
	| { readonly exists: false }
	| { readonly exists: true; readonly bytes: Uint8Array; readonly hash: string; readonly sizeBytes: number };

export type MutationTransform<TPrepared, TRejected = never> =
	| { readonly type: "commit"; readonly bytes: Uint8Array; readonly prepared: TPrepared }
	| { readonly type: "reject"; readonly reason: TRejected };

export interface MutationReceipt extends ContentVersion {
	readonly before?: ContentVersion;
	readonly created: boolean;
	/** 提交前重新验证的目标身份。 */
	readonly target: TargetRef;
}

export type MutationRunResult<TPrepared, TRejected = never> =
	| { readonly committed: true; readonly receipt: MutationReceipt; readonly prepared: TPrepared }
	| { readonly committed: false; readonly reason: TRejected; readonly snapshot: MutationSnapshot };

export interface MutationOptions {
	readonly createParents: boolean;
	readonly maxSnapshotBytes?: number;
	readonly maxOutputBytes?: number;
}

export interface MutationOperations {
	/** 只有成功提交才返回准备结果，回调不需要通过外部可变状态传递数据。 */
	run<TPrepared, TRejected = never>(
		target: TargetRef,
		options: MutationOptions,
		transform: (snapshot: MutationSnapshot) => MutationTransform<TPrepared, TRejected> | Promise<MutationTransform<TPrepared, TRejected>>,
	): Promise<FsResult<MutationRunResult<TPrepared, TRejected>>>;
}
