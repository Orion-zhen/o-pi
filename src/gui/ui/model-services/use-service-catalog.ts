import { useCallback, useEffect, useRef, useState } from "react";
import type { Query } from "../../contract.ts";
import type { ModelServiceCatalog } from "../../model-services.ts";
import type { Send } from "../runtime/connection.ts";

export type CatalogQuery = Query<{ query: "modelServiceCatalog"; provider: string }>;
type CatalogState = {
	value: ModelServiceCatalog | undefined;
	status: "loading" | "ready" | "refreshing" | "refreshed";
	error: string;
};
const initial: CatalogState = { value: undefined, status: "loading", error: "" };

export function useServiceCatalog(id: string, sessionId: string | undefined, savedContent: string, query: CatalogQuery, send: Send) {
	const [state, setState] = useState(initial);
	const active = useRef<symbol | undefined>(undefined);
	const load = useCallback(async (refresh = false) => {
		const request = Symbol();
		active.current = request;
		setState((current) => ({ ...current, status: refresh ? "refreshing" : "loading", error: "" }));
		try {
			if (refresh && !await send({ action: "refreshModelService", provider: id })) throw new Error("模型列表刷新失败");
			if (active.current !== request) return;
			const value = await query({ query: "modelServiceCatalog", provider: id });
			if (active.current === request) setState({ value, status: refresh ? "refreshed" : "ready", error: "" });
		} catch (error) {
			if (active.current === request) setState((current) => ({ ...current, status: "ready", error: error instanceof Error ? error.message : String(error) }));
		}
	}, [id, query, send]);
	useEffect(() => { setState(initial); }, [id, sessionId, query]);
	useEffect(() => {
		if (sessionId) void load();
		return () => { active.current = undefined; };
	}, [load, sessionId, savedContent]);
	return { ...state, refresh: () => load(true) };
}
