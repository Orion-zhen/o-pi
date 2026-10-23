import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Query } from "../../../../shared/protocol/queries.ts";
import type { ModelServiceCatalog } from "../../../../shared/config/model-services.ts";

export type CatalogQuery = Query<{ query: "modelServiceCatalog"; provider: string }>;
type CatalogState =
	| { phase: "idle" | "failed"; value: undefined }
	| { phase: "loading"; value: ModelServiceCatalog | undefined }
	| { phase: "ready"; value: ModelServiceCatalog };
const initial: CatalogState = { phase: "idle", value: undefined };
export type ServiceCatalogState = CatalogState & { canRetry: boolean; retry: () => Promise<void> };

export function useServiceCatalog({ id, sessionId, revision, savedContent, enabled, ready, query }: {
	id: string;
	sessionId: string | undefined;
	revision: number | undefined;
	savedContent: string;
	enabled: boolean;
	ready: boolean;
	query: CatalogQuery;
}): ServiceCatalogState {
	const scope = useMemo(() => Symbol(), [id, sessionId, revision, savedContent, enabled, query]);
	const [state, setState] = useState<CatalogState & { scope: symbol }>({ ...initial, scope });
	const active = useRef<symbol | undefined>(undefined);
	const current = state.scope === scope ? state : initial;
	const canRetry = !!sessionId && enabled && ready && current.phase !== "loading";
	const retry = useCallback(async () => {
		if (!canRetry) return;
		const request = Symbol();
		active.current = request;
		setState((previous) => ({ scope, phase: "loading", value: previous.scope === scope ? previous.value : undefined }));
		try {
			const value = await query({ query: "modelServiceCatalog", provider: id });
			if (active.current === request) setState({ scope, phase: "ready", value });
		} catch {
			if (active.current === request) setState({ scope, phase: "failed", value: undefined });
		}
	}, [id, query, scope, canRetry]);
	useEffect(() => () => { active.current = undefined; }, [scope]);
	useEffect(() => {
		if (current.phase === "idle") void retry();
	}, [current.phase, retry]);
	return { ...current, canRetry, retry };
}
