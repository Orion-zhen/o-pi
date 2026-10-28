import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { GlobalQuery, Query, WorkspaceQuery } from "../../shared/protocol/queries.ts";
import type { GuiAction } from "../../shared/protocol/actions.ts";
import type { GuiEvent } from "../../shared/protocol/events.ts";
import { useWorkbench } from "@/features/workspace/use-workbench.ts";
import { useWindowRefresh } from "@/connection/use-window-refresh.ts";
import { useLayout } from "./use-layout.ts";
import { useSessionActivity } from "@/features/sessions/use-session-activity.ts";
import { sessionList } from "@/features/sessions/session-list.ts";
import { useSessionSearch } from "@/features/sessions/use-session-search.ts";
import { SessionViews, type SessionViewState } from "@/features/sessions/session-views.ts";
import { useHostState } from "@/connection/use-host-state.ts";
import { useConnection } from "@/connection/use-connection.ts";
import { useGuiConfig } from "@/features/preferences/use-gui-config.ts";
import { useStartupChangelog } from "./welcome/use-startup-changelog.ts";
import { useAuthActions } from "@/features/auth/use-auth-actions.ts";
import { usePanels } from "./use-panels.ts";
import { isTouchInput } from "@/ui/input-mode.ts";
import type { SidebarView } from "./controls.ts";
import { fileReference } from "../../shared/file-reference.ts";
import type { DesktopCommand } from "../../shared/protocol/desktop.ts";

/** 连接功能区域。草稿由编辑器订阅，宿主事件不持有本地交互状态。 */
export function useGui() {
	const [host, receive] = useHostState();
	const selectedId = host.navigation?.id ?? null;
	const selected = useRef<string | null>(null);
	const [error, setError] = useState("");
	const [views] = useState(() => new SessionViews());
	const [view, setView] = useState<SessionViewState>();
	const editor = useRef<HTMLTextAreaElement>(null);
	const [referenceVersion, setReferenceVersion] = useState(0);
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
			case "editor":
				views.writeText(event.sessionId, event.text, event.mode);
				if (selected.current === event.sessionId && !isTouchInput()) editor.current?.focus();
				break;
		}
	});
	const { connected, status, attend, send: dispatch, query: readQuery } = connection;
	const dispatchSelected = useCallback(<A extends GuiAction>(action: A) => dispatch(action, selectedId), [dispatch, selectedId]);
	const auth = useAuthActions(dispatchSelected, setError, panels.closePanel);
	useEffect(() => { if (!connected) auth.finish(); }, [connected, auth.finish]);
	const send = auth.send;
	const desktopCommand = useEffectEvent((command: DesktopCommand) => {
		if (command === "settings") panels.setPanel({ kind: "settings" });
		if (command === "new" && connected) void send({ action: "new" });
	});
	useEffect(() => window.opi?.onCommand(desktopCommand), []);
	const query = useCallback<Query>((request) => readQuery(request, selectedId), [readQuery, selectedId]);
	const sharedQuery = useCallback<Query<GlobalQuery | WorkspaceQuery>>((request) => readQuery(request, null), [readQuery]);
	const globalQuery: Query<GlobalQuery> = sharedQuery;
	const config = useGuiConfig(connected, globalQuery, setError);
	const versionChecked = useRef(false);
	const [availableVersion, setAvailableVersion] = useState<string | null>(null);
	useEffect(() => {
		if (!connected || versionChecked.current) return;
		versionChecked.current = true;
		void globalQuery({ query: "availableVersion" }).then(setAvailableVersion).catch((error: unknown) => setError(String(error)));
	}, [connected, globalQuery]);
	useEffect(() => {
		if (!connected) return;
		const observe = () => { void dispatch({ action: "observe", visible: document.visibilityState === "visible" }, selected.current).catch((error: unknown) => setError(String(error))); };
		observe();
		document.addEventListener("visibilitychange", observe);
		return () => document.removeEventListener("visibilitychange", observe);
	}, [connected, dispatch]);
	useEffect(() => { if (connected) attend(selectedId); }, [connected, selectedId, attend]);
	const [sessionsLoading, setSessionsLoading] = useState(false);
	const refreshSessions = useCallback(async () => {
		setSessionsLoading(true);
		try { await dispatch({ action: "sessions" }, null); }
		catch (error) { setError(String(error)); }
		finally { setSessionsLoading(false); }
	}, [dispatch]);
	useEffect(() => { if (connected) void refreshSessions(); }, [connected, refreshSessions]);
	useWindowRefresh(connected, refreshSessions);
	const snapshot = host.snapshot?.sessionId === selectedId ? host.snapshot : null;
	const changelog = useStartupChangelog(connected, snapshot, selectedId, globalQuery, dispatch, setError);
	const cwd = host.navigation?.cwd ?? host.workspaceRoot;
	const layout = useLayout(setError);
	const sessionSearch = useSessionSearch(cwd, connected, host.sessions, globalQuery, dispatch, setError);
	const workbench = useWorkbench(cwd, connected, activity.some((item) => item.cwd === cwd && item.state !== "idle"), sharedQuery);
	const openFile = useCallback((path: string) => { workbench.openFile(path); panels.selectTab("file"); panels.setSessionPanelOpen(true); }, [workbench.openFile, panels.selectTab]);
	const setDraft = useCallback((text: string) => { if (view) views.writeText(view.id, text); }, [view, views]);
	const referenceFile = useCallback((path: string) => {
		if (!view) return false;
		let reference: string;
		try { reference = fileReference(path); }
		catch (error) { setError(String(error)); return false; }
		views.update(view, (draft) => ({ ...draft, text: `${draft.text}${draft.text && !/\s$/.test(draft.text) ? " " : ""}${reference}` }));
		editor.current?.focus();
		setReferenceVersion((version) => version + 1);
		return true;
	}, [view, views]);
	const canSubmit = connected && snapshot?.canSubmit === true;
	const canChangeSession = connected && snapshot?.canChangeSession === true;
	const [usageLoading, setUsageLoading] = useState(false);
	const usagePending = useRef(false);
	const openUsage = useCallback(async (mobile: boolean) => {
		if (!canSubmit || usagePending.current) return;
		usagePending.current = true;
		setUsageLoading(true);
		if (mobile) panels.setPanel({ kind: "usage", value: "loading" });
		try {
			if (!await send({ action: "view", view: "usage" })) {
				panels.setPanel((panel) => panel?.kind === "usage" && panel.value === "loading" ? undefined : panel);
			}
		} finally {
			usagePending.current = false;
			setUsageLoading(false);
		}
	}, [canSubmit, send, panels.setPanel]);
	const sessionRows = useMemo(() => sessionList(host.sessions ?? [], activity, selectedId), [host.sessions, activity, selectedId]);
	const sidebar = useMemo<SidebarView>(() => ({
		cwd, activity, sessionRows, sessions: host.sessions, sessionsLoading, refreshSessions, connected, canSubmit, canChangeSession, canNavigate: connected, usageLoading, openUsage,
		workbench, sessionSearch, layout, openFile, referenceFile, send, query, globalQuery, setPanel: panels.setPanel, workspaceRoot: host.workspaceRoot, workspaces: host.workspaces, error, setError,
	}), [cwd, activity, sessionRows, host.sessions, sessionsLoading, refreshSessions, connected, canSubmit, canChangeSession, usageLoading, openUsage,
		workbench, sessionSearch, layout, openFile, referenceFile, send, query, globalQuery, panels.setPanel, host.workspaceRoot, host.workspaces, error]);
	return {
		...panels, ...sidebar, ...changelog, sidebar, snapshot, view, views, selectedId, markRead, setDraft, editor, referenceVersion, dispatch: dispatchSelected,
		guiConfig: config.document, refreshGuiConfig: config.refresh, availableVersion,
		dialogs: host.dialogs, notices: host.notices, status, reconnect: connection.reconnect, running: snapshot?.running ?? false,
		auth: auth.auth, authUrl: auth.authUrl, deviceCode: auth.deviceCode,
		sessionStats: host.stats?.sessionId === selectedId ? host.stats.value : undefined,
		telemetry: host.telemetry?.sessionId === selectedId ? host.telemetry.value : undefined,
	};
}
