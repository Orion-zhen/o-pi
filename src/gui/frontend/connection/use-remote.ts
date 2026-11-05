import { useCallback, useEffect, useState } from "react";
import { LatestRequest, type Remote } from "./latest-request.ts";
export type { Remote } from "./latest-request.ts";

type Load<T> = () => Promise<T>;

/** 读取函数标识查询作用域，刷新和卸载统一使旧结果失效。 */
export function useRemote<T>(load: Load<T>, enabled = true) {
	const [response, setResponse] = useState<{ load: Load<T>; result: Remote<T> }>();
	const [request] = useState(() => new LatestRequest());
	const refresh = useCallback(async () => {
		request.cancel();
		if (!enabled) return;
		setResponse({ load, result: { state: "loading" } });
		await request.run(load, (result) => setResponse({ load, result }));
	}, [load, enabled, request]);
	useEffect(() => {
		void refresh();
		return () => request.cancel();
	}, [refresh, request]);
	const result: Remote<T> = response?.load === load ? response.result : { state: "loading" };
	return { result, refresh };
}
