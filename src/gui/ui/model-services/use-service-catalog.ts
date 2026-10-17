import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Query } from "../../contract.ts";
import type { ModelServiceCatalog } from "../../model-services.ts";

export type CatalogQuery = Query<{ query: "modelServiceCatalog"; provider: string }>;
type CatalogState = { value: ModelServiceCatalog | undefined; loading: boolean; error: string };
const initial: CatalogState = { value: undefined, loading: false, error: "" };

export function useServiceCatalog(id: string, sessionId: string | undefined, savedContent: string, query: CatalogQuery, receive: (value: ModelServiceCatalog) => void) {
	const [state, setState] = useState(initial);
	const active = useRef<symbol | undefined>(undefined);
	const receiver = useRef(receive);
	useLayoutEffect(() => { receiver.current = receive; }, [receive]);
	const load = useCallback(async () => {
		const request = Symbol();
		active.current = request;
		setState((current) => ({ ...current, loading: true, error: "" }));
		let value: ModelServiceCatalog;
		try {
			value = await query({ query: "modelServiceCatalog", provider: id });
		} catch {
			if (active.current === request) setState({ value: undefined, loading: false, error: "获取候选模型失败，可重试或手动填写模型 ID" });
			return;
		}
		if (active.current === request) {
			setState({ value, loading: false, error: value.error });
			receiver.current(value);
		}
	}, [id, query]);
	useEffect(() => { setState(initial); }, [load, sessionId]);
	useEffect(() => {
		if (sessionId) void load();
		return () => { active.current = undefined; };
	}, [load, sessionId, savedContent]);
	return { ...state, retry: load };
}
