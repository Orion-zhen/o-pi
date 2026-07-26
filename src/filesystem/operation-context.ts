import type { FsOperationContext } from "./contracts/result.js";

/** Permanently binds an operation to its owner while preserving caller-local cancellation. */
export function bindOperationContext(
	ownerSignal: AbortSignal | undefined,
	caller: FsOperationContext,
): FsOperationContext {
	if (ownerSignal === undefined) return caller;
	if (caller.signal === undefined || caller.signal === ownerSignal) return { signal: ownerSignal };
	return { signal: AbortSignal.any([ownerSignal, caller.signal]) };
}
