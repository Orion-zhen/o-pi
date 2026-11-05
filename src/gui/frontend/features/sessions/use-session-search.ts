import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GuiConnection } from "../../../shared/protocol/connection.ts";
import type { GlobalQuery, Query } from "../../../shared/protocol/queries.ts";
import type { GuiSessionInfo } from "../../../shared/protocol/state.ts";
import type { SessionSearchHit } from "../../../shared/session-search.ts";
import { LatestRequest } from "@/connection/latest-request.ts";

export type SessionSearchResults = { hits: SessionSearchHit[] } & (
	| { state: "searching"; scanned: number; total: number }
	| { state: "done" }
	| { state: "error"; message: string }
);

export function useSessionSearch(cwd: string, connected: boolean, sessions: GuiSessionInfo[] | undefined,
	query: Query<GlobalQuery>, send: GuiConnection["send"], reportError: (message: string) => void) {
	const [input, setInput] = useState({ cwd, text: "" });
	const [response, setResponse] = useState<{ cwd: string; text: string; value: SessionSearchResults }>();
	const online = useRef(connected);
	online.current = connected;
	const text = input.cwd === cwd ? input.text : "";
	const normalized = text.trim();
	const setText = useCallback((text: string) => setInput({ cwd, text }), [cwd]);
	useEffect(() => { setInput({ cwd, text: "" }); }, [cwd]);

	useEffect(() => {
		if (!connected || !cwd || !normalized) return;
		const request = new LatestRequest();
		let id: string | undefined;
		const hits: SessionSearchHit[] = [];
		const cancel = () => {
			if (!id || !online.current) return;
			const current = id;
			id = undefined;
			void send({ action: "cancelSessionSearch", id: current }, null).catch((error: unknown) => {
				if (online.current) reportError(error instanceof Error ? error.message : String(error));
			});
		};
		setResponse({ cwd, text: normalized, value: { state: "searching", hits: [], scanned: 0, total: 0 } });
		const timer = setTimeout(() => {
			void request.run<SessionSearchResults>(async (publish, signal) => {
				signal.addEventListener("abort", cancel, { once: true });
				try {
					let page = await query({ query: "searchSessions", cwd, text: normalized });
					id = page.id;
					while (true) {
						signal.throwIfAborted();
						hits.push(...page.hits);
						if (page.done) { id = undefined; return { state: "done", hits: [...hits] }; }
						publish({ state: "searching", hits: [...hits], scanned: page.scanned, total: page.total });
						page = await query({ query: "continueSessionSearch", id: page.id });
					}
				} finally { signal.removeEventListener("abort", cancel); cancel(); }
			}, (result) => {
				setResponse({ cwd, text: normalized, value: result.state === "ready" ? result.value
					: { state: "error", hits: [...hits], message: result.message } });
			});
		}, 250);
		return () => { clearTimeout(timer); request.cancel(); };
	}, [cwd, normalized, connected, sessions, query, send, reportError]);

	let result: SessionSearchResults | undefined;
	if (normalized) {
		result = !connected ? { state: "error", hits: [], message: "连接已断开，恢复后重新搜索。" }
			: response?.cwd === cwd && response.text === normalized ? response.value
				: { state: "searching", hits: [], scanned: 0, total: 0 };
	}
	return useMemo(() => ({ text, setText, result }), [text, setText, result]);
}
export type SessionSearchView = ReturnType<typeof useSessionSearch>;
