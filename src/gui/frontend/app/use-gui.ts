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
import { useHostState } from "./use-host-state.ts";
import { useConnection } from "@/connection/use-connection.ts";
import { useGuiConfig } from "@/features/preferences/use-gui-config.ts";
import { useStartupChangelog } from "./welcome/use-startup-changelog.ts";
import { isLoginAction, useAuthActions } from "@/features/auth/use-auth-actions.ts";
import { usePanels } from "./use-panels.ts";
import { isTouchInput } from "@/ui/input-mode.ts";
import type { SidebarView } from "./controls.ts";
import { fileReference } from "../../shared/file-reference.ts";
import type { DesktopCommand } from "../../shared/protocol/desktop.ts";
import type { GlobalSend, Send } from "@/connection/connection.ts";
import type { SessionView } from "@/features/sessions/session-state.ts";
import { useNotifications } from "@/ui/notifications.tsx";

/** 连接功能区域。草稿由编辑器订阅，宿主事件不持有本地交互状态。 */
export function useGui() {
	const { host, receive, views, current } = useHostState();
	const session = host.selection;
	const selectedId = session?.target.id ?? null;
	const view = session?.view;
	const notifications = useNotifications();
	const setError = notifications.reportError;
	const editor = useRef<HTMLTextAreaElement>(null);
	const [referenceVersion, setReferenceVersion] = useState(0);
	const panels = usePanels(selectedId);
	const { activity, markRead: recordRead, forget } = useSessionActivity(host.activities, setError);
	const markRead = useCallback((id: string, completedAt: number) => { if (views.get(id)) recordRead(id, completedAt); }, [views, recordRead]);
	const connection = useConnection((event: GuiEvent) => {
		receive(event);
		auth.receive(event);
		switch (event.type) {
			case "sessionsDeleted": {
				const ids = views.remove(event);
				forget(ids);
				break;
			}
			case "historyInvalidated": sessionSearch.invalidate(event.workspaces); break;
			case "feedback": notifications.notify(event.message, event.tone); break;
			case "guiConfig": config.accept(event.value); break;
			case "panel": panels.setPanel(event.panel); break;
			case "sessionTab": panels.selectTab(event.tab); panels.setSessionPanelOpen(true); break;
			case "editor":
				views.writeText(event.sessionId, event.text, event.mode);
				if (current().selection?.target.id === event.sessionId && !isTouchInput()) editor.current?.focus();
				break;
		}
	});
	const { connected, status, send: dispatch, query: readQuery } = connection;
	const globalSend = useCallback<GlobalSend>(async (action) => { await dispatch(action, null); }, [dispatch]);
	const dispatchSelected = useCallback(<A extends GuiAction>(action: A) => dispatch(action, selectedId), [dispatch, selectedId]);
	const auth = useAuthActions(dispatchSelected, panels.closePanel);
	useEffect(() => { if (!connected) auth.finish(); }, [connected, auth.finish]);
	const send = useCallback<Send>(async (action) => {
		if (isLoginAction(action)) await auth.login(action);
		else {
			if (action.action === "dialog" && action.value !== null) auth.resume();
			await dispatchSelected(action);
		}
	}, [dispatchSelected, auth.login, auth.resume]);
	const desktopCommand = useEffectEvent((command: DesktopCommand) => {
		if (command === "settings") panels.setPanel({ kind: "settings" });
		if (command === "new" && connected) void send({ action: "new" }).catch(setError);
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
	const observe = useEffectEvent(() => {
		void dispatch({ action: "observe", visible: document.visibilityState === "visible" }, null).catch((error: unknown) => setError(String(error)));
	});
	useEffect(() => {
		if (!connected) return;
		observe();
		document.addEventListener("visibilitychange", observe);
		return () => document.removeEventListener("visibilitychange", observe);
	}, [connected, dispatch]);
	const [sessionsLoading, setSessionsLoading] = useState(false);
	const allSessions = panels.panel?.kind === "sessions";
	const refreshSessions = useCallback(async () => {
		setSessionsLoading(true);
		try { await dispatch({ action: "sessions", all: allSessions }, null); }
		catch (error) { setError(String(error)); }
		finally { setSessionsLoading(false); }
	}, [dispatch, allSessions]);
	useEffect(() => { if (connected) void refreshSessions(); }, [connected, refreshSessions]);
	useWindowRefresh(connected, refreshSessions);
	const snapshot = session?.snapshot ?? null;
	const changelog = useStartupChangelog(connected, snapshot, selectedId, globalQuery, dispatch, setError);
	const cwd = session?.target.cwd ?? host.workspaceRoot;
	const layout = useLayout(setError);
	const sessionSearch = useSessionSearch(cwd, connected, globalQuery, dispatch, setError);
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
		try { await send({ action: "view", view: "usage" }); }
		catch (error) {
			panels.setPanel((panel) => panel?.kind === "usage" && panel.value === "loading" ? undefined : panel);
			setError(error);
		} finally {
			usagePending.current = false;
			setUsageLoading(false);
		}
	}, [canSubmit, send, panels.setPanel, setError]);
	const sessionRows = useMemo(() => sessionList(host.sessions ?? [], activity, selectedId), [host.sessions, activity, selectedId]);
	const sidebar = useMemo<SidebarView>(() => ({
		cwd, activity, sessionRows, sessions: host.sessions, sessionsLoading, refreshSessions, connected, canSubmit, canChangeSession, canNavigate: connected, usageLoading, openUsage,
		workbench, sessionSearch, layout, openFile, referenceFile, send, globalSend, query, globalQuery, setPanel: panels.setPanel, workspaceRoot: host.workspaceRoot, workspaces: host.workspaces, setError,
	}), [cwd, activity, sessionRows, host.sessions, sessionsLoading, refreshSessions, connected, canSubmit, canChangeSession, usageLoading, openUsage,
		workbench, sessionSearch, layout, openFile, referenceFile, send, globalSend, query, globalQuery, panels.setPanel, host.workspaceRoot, host.workspaces, setError]);
	const boundSession = useMemo<SessionView | null>(() => session && { ...session, send, query, dispatch: dispatchSelected }, [session, send, query, dispatchSelected]);
	return {
		...panels, ...sidebar, ...changelog, sidebar, session: boundSession, views, markRead, setDraft, editor, referenceVersion, dispatch: dispatchSelected, notifications,
		guiConfig: config.document, refreshGuiConfig: config.refresh, availableVersion,
		status, reconnect: connection.reconnect,
		auth: auth.auth, authUrl: auth.authUrl, deviceCode: auth.deviceCode, authError: auth.error, setAuthError: auth.setError,
	};
}
