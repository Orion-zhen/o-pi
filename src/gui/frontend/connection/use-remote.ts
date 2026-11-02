import { useCallback, useEffect, useRef, useState } from "react";

export type Remote<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; message: string };
type Load<T> = () => Promise<T>;

/** 读取函数标识查询作用域，刷新和卸载统一使旧结果失效。 */
export function useRemote<T>(load: Load<T>, enabled = true) {
	const [response, setResponse] = useState<{ load: Load<T>; result: Remote<T> }>();
	const active = useRef<AbortController | undefined>(undefined);
	const refresh = useCallback(async () => {
		active.current?.abort();
		if (!enabled) return;
		const controller = new AbortController();
		active.current = controller;
		setResponse({ load, result: { state: "loading" } });
		try {
			const value = await load();
			if (!controller.signal.aborted) setResponse({ load, result: { state: "ready", value } });
		} catch (error) {
			if (!controller.signal.aborted) setResponse({ load, result: { state: "error", message: error instanceof Error ? error.message : String(error) } });
		}
	}, [load, enabled]);
	useEffect(() => {
		void refresh();
		return () => active.current?.abort();
	}, [refresh]);
	const result: Remote<T> = response?.load === load ? response.result : { state: "loading" };
	return { result, refresh };
}
