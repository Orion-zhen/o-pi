import type { FsOperationContext } from "./contracts/result.js";

const boundSignals = new WeakMap<AbortSignal, ReadonlySet<AbortSignal>>();

/** Permanently binds an operation to its owner while preserving caller-local cancellation. */
export function bindOperationContext(
	ownerSignal: AbortSignal | undefined,
	caller: FsOperationContext,
): FsOperationContext {
	if (ownerSignal === undefined) return caller;
	if (caller.signal === undefined) return { signal: ownerSignal };
	if (caller.signal === ownerSignal || boundSignals.get(caller.signal)?.has(ownerSignal) === true) return caller;
	const signal = AbortSignal.any([ownerSignal, caller.signal]);
	boundSignals.set(signal, new Set([
		ownerSignal,
		caller.signal,
		...(boundSignals.get(caller.signal) ?? []),
	]));
	return { signal };
}
