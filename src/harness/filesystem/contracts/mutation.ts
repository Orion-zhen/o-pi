import type { ContentVersion } from "./content.ts";
import type { TargetRef } from "./path.ts";

export type MutationSnapshot =
	| { readonly exists: false }
	| { readonly exists: true; readonly bytes: Uint8Array; readonly hash: string; readonly sizeBytes: number };

export interface PreparedMutation<T> {
	readonly bytes: Uint8Array;
	readonly prepared: T;
}

export interface MutationReceipt extends ContentVersion {
	readonly before?: ContentVersion;
	readonly created: boolean;
	/** 提交前重新验证的目标身份。 */
	readonly target: TargetRef;
}

export interface CommittedMutation<T> {
	readonly receipt: MutationReceipt;
	readonly prepared: T;
}

export interface MutationOptions {
	readonly createParents: boolean;
	readonly maxSnapshotBytes?: number;
	readonly maxOutputBytes?: number;
}

export interface MutationOperations {
	/** 返回即表示已提交，准备或提交失败通过异常退出并释放目标队列。 */
	run<T>(
		target: TargetRef,
		options: MutationOptions,
		prepare: (snapshot: MutationSnapshot) => PreparedMutation<T> | Promise<PreparedMutation<T>>,
	): Promise<CommittedMutation<T>>;
}
