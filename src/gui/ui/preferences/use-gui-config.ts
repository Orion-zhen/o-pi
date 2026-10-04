import { useCallback, useEffect, useRef, useState } from "react";
import type { GlobalQuery, Query } from "../../contract.ts";
import type { GuiConfigDocument } from "../../preferences.ts";
import { usePreferences } from "./use-preferences.ts";
import { useWindowRefresh } from "../runtime/use-window-refresh.ts";

export function useGuiConfig(connected: boolean, query: Query<GlobalQuery>, reportError: (message: string) => void) {
	const [document, setDocument] = useState<GuiConfigDocument>();
	const version = useRef(0);
	const accept = useCallback((value: GuiConfigDocument) => { version.current++; setDocument(value); }, []);
	const refresh = useCallback(async () => {
		const request = ++version.current;
		try {
			const value = await query({ query: "guiConfig" });
			if (request === version.current) setDocument(value);
		} catch (error) { if (request === version.current) reportError(error instanceof Error ? error.message : String(error)); }
	}, [query, reportError]);
	useEffect(() => {
		if (connected) void refresh();
		return () => { version.current++; };
	}, [connected, refresh]);
	useWindowRefresh(connected, refresh);
	usePreferences(document?.state === "ready" ? document.value : undefined, reportError);
	return { document, accept, refresh };
}
