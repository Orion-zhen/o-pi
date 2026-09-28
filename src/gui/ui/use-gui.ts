import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GlobalQuery, GuiAction, GuiEvent, Query, WorkspaceQuery } from "../contract.ts";
import { useWorkbench } from "./use-workbench.ts";
import { useWindowRefresh } from "./use-window-refresh.ts";
import { useLayout } from "./use-layout.ts";
import { useSessionActivity } from "./use-session-activity.ts";
import { sessionList } from "./session-list.ts";
import { SessionViews, type SessionViewState } from "./session-views.ts";
import { useHostState } from "./use-host-state.ts";
import { useConnection } from "./use-connection.ts";
import { useGuiConfig } from "./use-gui-config.ts";
import { useGuiActions } from "./use-gui-actions.ts";
import { usePanels } from "./use-panels.ts";
import { locateTranscript } from "./transcript-location.ts";
import type { SessionSnapshot, SidebarView } from "./gui-controls.ts";

/** 连接功能区域。草稿由编辑器订阅，宿主事件不持有本地交互状态。 */
export function useGui() {
	const [host, receive] = useHostState();
	const selectedId = host.navigation?.id ?? null;
	const selected = useRef<string | null>(null);
	const [error, setError] = useState("");
	const [views] = useState(() => new SessionViews());
	const [view, setView] = useState<SessionViewState>();
	const editor = useRef<HTMLTextAreaElement>(null);
	const panels = usePanels(selectedId);
	const { activity, markRead: recordRead, forget } = useSessionActivity(host.activities, setError);
	const markRead = useCallback((id: string, completedAt: number) => { if (views.get(id)) recordRead(id, completedAt); }, [views, recordRead]);
	const connection = useConnection((event: GuiEvent) => {
		receive(event);
		auth.receive(event);
		switch (event.type) {
			case "selected":
				selected.current = event.session?.id ?? null;
				setView(event.session ? views.open(event.session, event.draftFrom) : undefined);
				break;
			case "sessionsDeleted": {
				const ids = views.remove(event);
				forget(ids);
				if (selected.current && ids.includes(selected.current)) setView(undefined);
				break;
			}
			case "error": setError(event.message); break;
			case "guiConfig": config.accept(event.value); break;
			case "panel": panels.setPanel(event.panel); break;
			case "sessionTab": panels.selectTab(event.tab); panels.setSessionPanelOpen(true); break;
			case "editor": views.writeText(event.sessionId, event.text); if (selected.current === event.sessionId) editor.current?.focus(); break;
		}
	});
	const { connected, status, send: dispatch, query: readQuery } = connection;
	const dispatchSelected = useCallback((action: GuiAction) => dispatch(action, selectedId), [dispatch, selectedId]);
	const auth = useGuiActions(dispatchSelected, setError, panels.closePanel);
	useEffect(() => { if (!connected) auth.finish(); }, [connected, auth.finish]);
	const send = auth.send;
	const query = useCallback<Query>((request) => readQuery(request, selectedId), [readQuery, selectedId]);
	const sharedQuery = useCallback<Query<GlobalQuery | WorkspaceQuery>>((request) => readQuery(request, null), [readQuery]);
	const globalQuery: Query<GlobalQuery> = sharedQuery;
	const config = useGuiConfig(connected, globalQuery, setError);
	useEffect(() => {
		if (!connected) return;
		const observe = () => { void dispatch({ action: "observe", visible: document.visibilityState === "visible" }, selected.current).catch((error: unknown) => setError(String(error))); };
		observe();
		document.addEventListener("visibilitychange", observe);
		return () => document.removeEventListener("visibilitychange", observe);
	}, [connected, dispatch]);
	const [sessionsLoading, setSessionsLoading] = useState(false);
	const refreshSessions = useCallback(async () => {
		setSessionsLoading(true);
		try { await dispatch({ action: "sessions" }, null); }
		catch (error) { setError(String(error)); }
		finally { setSessionsLoading(false); }
	}, [dispatch]);
	useEffect(() => { if (connected) void refreshSessions(); }, [connected, refreshSessions]);
	useWindowRefresh(connected, refreshSessions);
	const current = host.snapshot?.sessionId === selectedId ? host.snapshot : null;
	const history = useMemo(() => current ? locateTranscript(current, undefined) : undefined, [current?.entries, current?.contextEntryIds, current?.leafId]);
	const snapshot = useMemo<SessionSnapshot | null>(() => current && history ? { ...current, messages: history.messages } : null, [current, history]);
	const cwd = host.navigation?.cwd ?? host.workspaceRoot;
	const layout = useLayout(setError);
	const workbench = useWorkbench(cwd, connected, activity.some((item) => item.cwd === cwd && item.state !== "idle"), sharedQuery);
	const openFile = useCallback((path: string) => { workbench.openFile(path); panels.selectTab("file"); panels.setSessionPanelOpen(true); }, [workbench.openFile, panels.selectTab]);
	const setDraft = useCallback((text: string) => { if (view) views.writeText(view.id, text); }, [view, views]);
	const referenceFile = useCallback((path: string) => {
		if (/[\r\n]/.test(path) || (path.includes('"') && path.includes("'"))) { setError("此文件名不能表示为 @ 引用。"); return; }
		const quoted = /[\s'"]/.test(path) ? (path.includes('"') ? `'${path}'` : `"${path}"`) : path;
		if (view) views.update(view, (draft) => ({ ...draft, text: `${draft.text}${draft.text && !/\s$/.test(draft.text) ? " " : ""}@${quoted} ` }));
		editor.current?.focus();
	}, [view, views]);
	const canSubmit = connected && snapshot?.canSubmit === true;
	const canChangeSession = connected && snapshot?.canChangeSession === true;
	const sessionRows = useMemo(() => sessionList(host.sessions ?? [], activity, selectedId), [host.sessions, activity, selectedId]);
	const sidebar = useMemo<SidebarView>(() => ({
		cwd, activity, sessionRows, sessions: host.sessions, sessionsLoading, refreshSessions, connected, canSubmit, canChangeSession, canNavigate: connected,
		workbench, layout, openFile, referenceFile, send, query, globalQuery, setPanel: panels.setPanel, workspaceRoot: host.workspaceRoot, workspaces: host.workspaces, error, setError,
	}), [cwd, activity, sessionRows, host.sessions, sessionsLoading, refreshSessions, connected, canSubmit, canChangeSession,
		workbench, layout, openFile, referenceFile, send, query, globalQuery, panels.setPanel, host.workspaceRoot, host.workspaces, error]);
	return {
		...panels, ...sidebar, sidebar, snapshot, view, views, selectedId, markRead, setDraft, editor,
		guiConfig: config.document, refreshGuiConfig: config.refresh,
		dialogs: host.dialogs, notices: host.notices, status, reconnect: connection.reconnect, running: snapshot?.running ?? false,
		auth: auth.auth, authUrl: auth.authUrl, deviceCode: auth.deviceCode,
		sessionStats: host.stats?.sessionId === selectedId ? host.stats.value : undefined,
		telemetry: host.telemetry?.sessionId === selectedId ? host.telemetry.value : undefined,
	};
}
