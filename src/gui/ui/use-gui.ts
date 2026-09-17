import { useCallback, useEffect, useRef, useState } from "react";
import type { GuiConnection, GuiDialog, GuiEvent, GuiNotice, GuiPanel, GuiSessionInfo, GuiSessionTab, GuiSnapshot, GuiSessionDetails, GuiWorkspaceInfo, Query } from "../contract.ts";
import { useWorkbench } from "./use-workbench.ts";
import { useWindowRefresh } from "./use-window-refresh.ts";
import { connectGui, type ConnectionStatus, type Send } from "./connection.ts";
import type { GuiConfigDocument } from "../preferences.ts";
import { usePreferences } from "./use-preferences.ts";
import { useLayout } from "./use-layout.ts";

/** 共享宿主状态与跨区域导航，查询结果由使用它的组件持有。 */
export function useGui() {
	const [snapshot, setSnapshot] = useState<GuiSnapshot | null>(null);
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
	const [draft, setDraft] = useState("");
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
			if (status === "connected") { setNotices([]); setDialogs([]); }
		});
		connection.current = client;
		const unsubscribe = client.subscribe((event) => {
			switch (event.type) {
				case "guiConfig": configVersion.current++; setGuiConfig(event.value); break;
				case "workspaceRoot": setWorkspaceRoot(event.path); break;
				case "workspaces": setWorkspaces(event.value); break;
				case "sessionInfo": setSessionDetails(event.value); break;
				case "snapshot":
					setSnapshot(event.value);
					if (!event.value) { setDraft(""); setAuth(undefined); }
					break;
				case "sessions": setSessions(event.value); break;
				case "dialogs": setDialogs(event.value); break;
				case "notice":
					setNotices((current) => [...current.filter((notice) => notice.id !== event.value.id), event.value].slice(-100));
					break;
				case "sessionTab": selectTab(event.tab); setSessionPanelOpen(true); break;
				case "panel": setPanel(event.panel); break;
				case "editor": setDraft(event.text); editor.current?.focus(); break;
				case "auth": setAuth(event.value); break;
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
		return () => { unsubscribe(); client.close(); connection.current = undefined; };
	}, [revision, selectTab]);

	const send: Send = useCallback(async (action) => {
		try {
			if (!connection.current) throw new Error("连接尚未就绪。");
			await connection.current.send(action);
			return true;
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
			return false;
		}
	}, []);
	const query = useCallback<Query>((request) => {
		if (!connection.current) return Promise.reject(new Error("连接尚未就绪。"));
		return connection.current.query(request);
	}, []);
	const connected = status === "connected";
	const refreshGuiConfig = useCallback(async () => {
		const version = ++configVersion.current;
		try {
			const value = await query({ query: "guiConfig" });
			if (version === configVersion.current) setGuiConfig(value);
		} catch (error) {
			if (version === configVersion.current) setError(error instanceof Error ? error.message : String(error));
		}
	}, [query]);
	useEffect(() => { if (connected) void refreshGuiConfig(); }, [connected, refreshGuiConfig]);
	useWindowRefresh(connected, refreshGuiConfig);
	const refreshSessions = useCallback(async () => {
		setSessionsLoading(true);
		try { await send({ action: "sessions" }); }
		finally { setSessionsLoading(false); }
	}, [send]);
	useEffect(() => { if (connected) void refreshSessions(); }, [connected, revision, refreshSessions]);
	useWindowRefresh(connected, refreshSessions);
	useEffect(() => {
		setPanel((panel) => panel?.kind === "settings" ? panel : undefined);
		setSessionPanelOpen(true);
	}, [snapshot?.sessionId]);
	const running = snapshot?.running ?? false;
	const workbench = useWorkbench(snapshot?.cwd, connected, running, query);
	return {
		workbench, guiConfig, refreshGuiConfig, layout,
		openFile: (path: string) => { workbench.openFile(path); selectTab("file"); setSessionPanelOpen(true); },
		referenceFile: (path: string) => {
			if (/[\r\n]/.test(path) || (path.includes('"') && path.includes("'"))) {
				setError("此文件名不能表示为 @ 引用。");
				return;
			}
			const quoted = /[\s'"]/.test(path) ? (path.includes('"') ? `'${path}'` : `"${path}"`) : path;
			setDraft((draft) => `${draft}${draft && !/\s$/.test(draft) ? " " : ""}@${quoted} `);
			editor.current?.focus();
		},
		snapshot, sessions, sessionsLoading, refreshSessions, dialogs, notices,
		status, connected, error, setError, panel, setPanel,
		sessionTab, activeTab, selectTab, sessionPanelOpen, setSessionPanelOpen,
		sessionDetails: sessionDetails?.sessionId === snapshot?.sessionId ? sessionDetails : undefined,
		workspaceRoot, workspaces, auth, setAuth, draft, setDraft, editor, send, query, running,
		canSubmit: connected && snapshot?.canSubmit === true,
		canChangeSession: connected && snapshot?.canChangeSession === true,
		reconnect: () => setRevision((value) => value + 1),
	};
}
export type GuiView = ReturnType<typeof useGui>;
