import { useCallback, useLayoutEffect, useRef, useState } from "react";

export type OperationState<Args extends unknown[], T> =
	| { state: "idle" }
	| { state: "pending"; args: Args }
	| { state: "succeeded"; args: Args; value: T }
	| { state: "failed"; args: Args; message: string };

/** 一次操作只有一个状态所有者。卸载只使界面回调失效，不取消已经提交的任务。 */
export function useOperation<Args extends unknown[], T>(task: (...args: Args) => Promise<T>, succeeded?: (value: T, ...args: Args) => void) {
	const [state, setState] = useState<OperationState<Args, T>>({ state: "idle" });
	const current = useRef(state);
	useLayoutEffect(() => () => { current.current = { state: "idle" }; }, []);
	const update = (state: OperationState<Args, T>) => { current.current = state; setState(state); };
	const run = useCallback((...args: Args): void => {
		if (current.current.state === "pending") return;
		const request = { state: "pending" as const, args };
		update(request);
		void (async () => {
			let value: T;
			try { value = await task(...args); }
			catch (error) {
				if (current.current === request) update({ state: "failed", args, message: error instanceof Error ? error.message : String(error) });
				return;
			}
			if (current.current !== request) return;
			update({ state: "succeeded", args, value });
			// 成功回调中的程序错误交给全局诊断，不伪装成请求失败。
			succeeded?.(value, ...args);
		})();
	}, [task, succeeded]);
	const reset = useCallback((discard?: () => void) => {
		if (current.current.state === "pending") return;
		discard?.();
		update({ state: "idle" });
	}, []);
	return { state, run, reset, pending: state.state === "pending", error: state.state === "failed" ? state.message : "" };
}
