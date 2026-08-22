import type { FsOperationContext } from "../../filesystem/contracts/result.js";

/** 组合仅供 file-tools 自身使用的生命周期取消信号。 */
export function combineOperationContext(
	context: FsOperationContext,
	owner: AbortSignal,
	...additional: readonly AbortSignal[]
): FsOperationContext {
	if (context.signal === undefined && additional.length === 0) return { signal: owner };
	return {
		signal: AbortSignal.any([
		...(context.signal === undefined ? [] : [context.signal]),
		owner,
		...additional,
		]),
	};
}
