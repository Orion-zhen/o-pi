import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GuiConnection, GlobalQuery, WorkspaceQuery, GuiDialog, GuiEvent, GuiNotice, GuiPanel, GuiSessionActivity, GuiSessionInfo, GuiSessionTab, GuiSnapshot, GuiSessionDetails, GuiWorkspaceInfo, Query } from "../contract.ts";
import { useWorkbench } from "./use-workbench.ts";
import { useWindowRefresh } from "./use-window-refresh.ts";
import { connectGui, type ConnectionStatus, type Send } from "./connection.ts";
import type { GuiConfigDocument } from "../preferences.ts";
import { usePreferences } from "./use-preferences.ts";
import { useLayout } from "./use-layout.ts";
import { OAuthBrowser } from "./oauth-browser.ts";
import { useSessionDraft } from "./use-session-draft.ts";
import { useSessionActivity } from "./use-session-activity.ts";
import { sessionList } from "./session-list.ts";
import { SessionViews, type SessionViewState } from "./session-views.ts";

/** 共享宿主状态与跨区域导航，查询结果由使用它的组件持有。 */
export function useGui() {
	const [navigation, setNavigation] = useState<Extract<GuiEvent, { type: "selected" }>["session"]>(null);
	const selectedId = navigation?.id ?? null;
	const selected = useRef<string | null>(null);
	const [currentSnapshot, setSnapshot] = useState<GuiSnapshot | null>(null);
	const snapshot = currentSnapshot?.sessionId === selectedId ? currentSnapshot : null;
	const [activities, setActivities] = useState<GuiSessionActivity[]>([]);
	const [guiConfig, setGuiConfig] = useState<GuiConfigDocument>();
	const configVersion = useRef(0);
	usePreferences(guiConfig?.state === "ready" ? guiConfig.value : undefined);
	const [sessions, setSessions] = useState<GuiSessionInfo[]>();
	const [sessionsLoading, setSessionsLoading] = useState(false);
	const [dialogs, setDialogs] = useState<GuiDialog[]>([]);
	const [notices, setNotices] = useState<GuiNotice[]>([]);
	const [status, setStatus] = useState<ConnectionStatus>("connecting");
	const [error, setError] = useState("");
	const layout = useLayout(setError);
	const [panel, setPanel] = useState<GuiPanel>();
	const [sessionTab, setSessionTab] = useState<GuiSessionTab>("tree");
	const [activeTab, setActiveTab] = useState<GuiSessionTab | "file">("tree");
	const [sessionPanelOpen, setSessionPanelOpen] = useState(true);
	const [sessionDetails, setSessionDetails] = useState<GuiSessionDetails>();
	const [workspaceRoot, setWorkspaceRoot] = useState("");
	const [workspaces, setWorkspaces] = useState<GuiWorkspaceInfo[]>([]);
	const [auth, setAuth] = useState<Extract<GuiEvent, { type: "auth" }>["value"]>();
	const [authUrl, setAuthUrl] = useState<string>();
	const [deviceCode, setDeviceCode] = useState<string>();
	const [oauthBrowser] = useState(() => new OAuthBrowser());
	const loginPending = useRef(false);
	const [views] = useState(() => new SessionViews());
	const [view, setView] = useState<SessionViewState>();
	const composer = useSessionDraft(view, views);
	const { draft, setDraft, writeDraft } = composer;
	const { activity, markRead: recordRead, forget } = useSessionActivity(activities, setError);
	const markRead = useCallback((id: string, completedAt: number) => { if (views.get(id)) recordRead(id, completedAt); }, [views, recordRead]);
	const sessionRows = useMemo(() => sessionList(sessions ?? [], activity, selectedId), [sessions, activity, selectedId]);
	const [revision, setRevision] = useState(0);
	const connection = useRef<GuiConnection | undefined>(undefined);
	const editor = useRef<HTMLTextAreaElement>(null);
	const selectTab = useCallback((tab: GuiSessionTab | "file") => {
		setActiveTab(tab);
		if (tab !== "file") setSessionTab(tab);
	}, []);

	useEffect(() => {
		const client = connectGui((status) => {
			setStatus(status);
		});
		connection.current = client;
		const unsubscribe = client.subscribe((event) => {
			switch (event.type) {
				case "selected":
					selected.current = event.session?.id ?? null;
					setNavigation(event.session);
					setView(event.session ? views.open(event.session) : undefined);
					break;
				case "sessionsDeleted": {
					const ids = views.remove(event);
					forget(ids);
					setActivities((items) => items.filter((item) => !ids.includes(item.sessionId)));
					setSessions((items) => items?.filter((item) => !event.paths.includes(item.path)));
					if (selected.current && ids.includes(selected.current)) { setView(undefined); setSnapshot(null); }
					break;
				}
				case "activity": setActivities(event.value); break;
				case "error": setError(event.message); break;
				case "guiConfig": configVersion.current++; setGuiConfig(event.value); break;
				case "workspaceRoot": setWorkspaceRoot(event.path); break;
				case "workspaces": setWorkspaces(event.value); break;
				case "sessionInfo": setSessionDetails(event.value); break;
				case "snapshot":
					setSnapshot(event.value);
					if (!event.value) setAuth(undefined);
					break;
				case "sessions": setSessions(event.value); break;
				case "dialogs":
					if (event.value.length) oauthBrowser.waitForInput();
					setDialogs(event.value); break;
				case "notices":
					setNotices(event.value);
					break;
				case "sessionTab": selectTab(event.tab); setSessionPanelOpen(true); break;
				case "panel": setPanel(event.panel); break;
				case "editor": writeDraft(event.sessionId, event.text); if (selected.current === event.sessionId) editor.current?.focus(); break;
				case "auth": {
					setAuth(event.value);
					if (!event.value) {
						oauthBrowser.finish(); setAuthUrl(undefined); setDeviceCode(undefined);
						break;
					}
					const url = event.value.type === "auth_url" ? event.value.url
						: event.value.type === "device_code" ? event.value.verificationUri : undefined;
					if (event.value.type === "device_code") setDeviceCode(event.value.userCode);
					if (url) {
						setAuthUrl(url);
						void oauthBrowser.open(url).catch((error: unknown) => setError(String(error)));
					}
					break;
				}
				case "download": {
					const url = URL.createObjectURL(new Blob([event.content], { type: event.mimeType }));
					const link = document.createElement("a");
					link.href = url;
					link.download = event.name;
					link.click();
					setTimeout(() => URL.revokeObjectURL(url), 1000);
					break;
				}
				case "close": client.close(); setStatus("closed"); break;
			}
		});
		return () => { unsubscribe(); client.close(); connection.current = undefined; oauthBrowser.finish(); };
	}, [revision, selectTab, oauthBrowser, writeDraft, views, forget]);

	const send: Send = useCallback(async (action) => {
		if (action.action === "login") {
			if (loginPending.current) return false;
			loginPending.current = true;
		}
		try {
			if (!connection.current) throw new Error("连接尚未就绪。");
			if (action.action === "login" && action.type === "oauth") {
				setPanel(undefined);
				setAuthUrl(undefined); setDeviceCode(undefined);
				oauthBrowser.prepare();
			}
			if (action.action === "dialog" && action.value !== null) oauthBrowser.resume();
			await connection.current.send(action, selectedId);
			return true;
		} catch (error) {
			if (action.action === "login") { oauthBrowser.finish(); setAuth(undefined); setAuthUrl(undefined); setDeviceCode(undefined); }
			setError(error instanceof Error ? error.message : String(error));
			return false;
		} finally {
			if (action.action === "login") loginPending.current = false;
		}
	}, [oauthBrowser, selectedId]);
	const query = useCallback<Query>((request) => {
		if (!connection.current) return Promise.reject(new Error("连接尚未就绪。"));
		return connection.current.query(request, selectedId);
	}, [selectedId]);
	const sharedQuery = useCallback<Query<GlobalQuery | WorkspaceQuery>>((request) => {
		if (!connection.current) return Promise.reject(new Error("连接尚未就绪。"));
		return connection.current.query(request, null);
	}, []);
	const globalQuery: Query<GlobalQuery> = sharedQuery;
	const cwd = navigation?.cwd ?? workspaceRoot;
	const connected = status === "connected";
	useEffect(() => {
		if (!connected) return;
		const observe = () => {
			void connection.current?.send({ action: "observe", visible: document.visibilityState === "visible" }, selected.current)
				.catch((error: unknown) => setError(String(error)));
		};
		observe();
		document.addEventListener("visibilitychange", observe);
		return () => document.removeEventListener("visibilitychange", observe);
	}, [connected]);
	const refreshGuiConfig = useCallback(async () => {
		const version = ++configVersion.current;
		try {
			const value = await globalQuery({ query: "guiConfig" });
			if (version === configVersion.current) setGuiConfig(value);
		} catch (error) {
			if (version === configVersion.current) setError(error instanceof Error ? error.message : String(error));
		}
	}, [globalQuery]);
	useEffect(() => { if (connected) void refreshGuiConfig(); }, [connected, refreshGuiConfig]);
	useWindowRefresh(connected, refreshGuiConfig);
	const refreshSessions = useCallback(async () => {
		setSessionsLoading(true);
		try {
			if (!connection.current) throw new Error("连接尚未就绪。");
			await connection.current.send({ action: "sessions" }, null);
		} catch (error) { setError(String(error)); }
		finally { setSessionsLoading(false); }
	}, []);
	useEffect(() => { if (connected) void refreshSessions(); }, [connected, revision, refreshSessions]);
	useWindowRefresh(connected, refreshSessions);
	useEffect(() => {
		setPanel((panel) => panel?.kind === "settings" ? panel : undefined);
		setSessionPanelOpen(true);
	}, [selectedId]);
	const running = snapshot?.running ?? false;
	const workspaceRunning = activity.some((item) => item.cwd === cwd && item.state !== "idle");
	const workbench = useWorkbench(cwd, connected, workspaceRunning, sharedQuery);
	const openFile = useCallback((path: string) => { workbench.openFile(path); selectTab("file"); setSessionPanelOpen(true); }, [workbench.openFile, selectTab]);
	const referenceFile = useCallback((path: string) => {
		if (/[\r\n]/.test(path) || (path.includes('"') && path.includes("'"))) {
			setError("此文件名不能表示为 @ 引用。");
			return;
		}
		const quoted = /[\s'"]/.test(path) ? (path.includes('"') ? `'${path}'` : `"${path}"`) : path;
		setDraft((draft) => `${draft}${draft && !/\s$/.test(draft) ? " " : ""}@${quoted} `);
		editor.current?.focus();
	}, [setDraft]);
	const canSubmit = connected && snapshot?.canSubmit === true;
	const canChangeSession = connected && snapshot?.canChangeSession === true;
	const sidebar = useMemo(() => ({
		cwd, activity, sessionRows, sessions, sessionsLoading, refreshSessions, connected, canSubmit, canChangeSession, canNavigate: connected,
		workbench, layout, openFile, referenceFile, send, query, globalQuery, setPanel, workspaceRoot, workspaces, error, setError,
	}), [cwd, activity, sessionRows, sessions, sessionsLoading, refreshSessions, connected, canSubmit, canChangeSession,
		workbench, layout, openFile, referenceFile, send, query, globalQuery, workspaceRoot, workspaces, error]);
	return {
		workbench, guiConfig, refreshGuiConfig, layout, openFile, referenceFile, sidebar, composer, view, cwd, selectedId, activity, markRead,
		snapshot, sessionRows, sessions, sessionsLoading, refreshSessions, dialogs, notices,
		status, connected, error, setError, panel, setPanel,
		sessionTab, activeTab, selectTab, sessionPanelOpen, setSessionPanelOpen,
		sessionDetails: sessionDetails?.sessionId === snapshot?.sessionId ? sessionDetails : undefined,
		workspaceRoot, workspaces, auth, authUrl, deviceCode, draft, setDraft, editor, send, query, globalQuery, running,
		canSubmit, canChangeSession, canNavigate: connected,
		reconnect: () => setRevision((value) => value + 1),
	};
}
export type GuiView = ReturnType<typeof useGui>;
export type SidebarView = GuiView["sidebar"];
