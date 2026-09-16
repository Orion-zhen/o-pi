import { useMemo, useState } from "react";
import { ChevronRight, FolderClosed, RefreshCw } from "lucide-react";
import type { GuiSessionInfo } from "../contract.ts";
import type { GuiView } from "./use-gui.ts";
import { IconButton } from "./components/icon-button";
import { Button } from "./components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { HistorySessionRow } from "./history-session-row.tsx";
import "./sessions.css";

const workspaceName = (cwd: string) => cwd.split(/[/\\]/).filter(Boolean).at(-1) || cwd || "未记录工作区";
type HistoryGui = Pick<GuiView, "snapshot" | "sessions" | "sessionsLoading" | "refreshSessions" | "send" | "canChangeSession" | "connected">;

export function SessionHistory({ gui, close, full = false, search = "" }: {
	gui: HistoryGui; close: () => void; full?: boolean; search?: string;
}) {
	const groups = useMemo(() => {
		const result = new Map<string, GuiSessionInfo[]>();
		if (gui.snapshot) result.set(gui.snapshot.cwd, []);
		for (const session of [...gui.sessions ?? []].sort((a, b) => b.modified.localeCompare(a.modified))) {
			const group = result.get(session.cwd);
			if (group) group.push(session); else result.set(session.cwd, [session]);
		}
		return [...result];
	}, [gui.sessions, gui.snapshot?.cwd]);
	return <section className={`session-history${full ? "" : " session-history-flat"}`} aria-label="历史会话">
		<div className="history-heading">
			<h2>{full ? "全部会话" : "会话"}</h2>
			<IconButton label="刷新会话" disabled={gui.sessionsLoading || !gui.connected} onClick={() => void gui.refreshSessions()}>
				<RefreshCw className={gui.sessionsLoading ? "animate-spin" : undefined} />
			</IconButton>
		</div>
		<div className="history-scroll">
			{!gui.sessions && <p className="history-hint" role="status">正在读取历史会话…</p>}
			{groups.filter(([cwd]) => full || cwd === gui.snapshot?.cwd).map(([cwd, items]) => {
				const rows = <SessionRows cwd={cwd} items={items} gui={gui} close={close} search={search} />;
				return full ? <Collapsible key={cwd} defaultOpen className="workspace-sessions">
					<CollapsibleTrigger asChild><Button variant="ghost" className="workspace-toggle" title={cwd}>
						<ChevronRight className="workspace-chevron" /><FolderClosed /><span className="workspace-label">{workspaceName(cwd)}</span>
					</Button></CollapsibleTrigger>
					<CollapsibleContent>{rows}</CollapsibleContent>
				</Collapsible> : <div key={cwd}>{rows}</div>;
			})}
		</div>
	</section>;
}

function SessionRows({ cwd, items, gui, close, search }: {
	cwd: string; items: GuiSessionInfo[]; gui: HistoryGui; close: () => void; search: string;
}) {
	const [switching, setSwitching] = useState(false);
	const { snapshot } = gui;
	const active = items.find((item) => item.path === snapshot?.sessionFile);
	const blocked = switching || !gui.canChangeSession;
	const matches = (title: string) => title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
	const titleOf = (item: GuiSessionInfo) => item === active && snapshot?.name ? snapshot.name : item.title;
	const visible = items.filter((item) => matches(titleOf(item)));
	const unsaved = cwd === snapshot?.cwd && !active && matches(snapshot.name || "新会话");
	return <div className="workspace-session-list">
		{unsaved && <HistorySessionRow key={snapshot.sessionId} title={snapshot.name || "新会话"}
			path={snapshot.sessionFile} selected disabled={blocked} send={gui.send} open={close} />}
		{visible.map((item) => <HistorySessionRow key={item.path} title={titleOf(item)} path={item.path} modified={item.modified}
			selected={item === active} disabled={blocked} send={gui.send} open={() => {
				close();
				if (item === active) return;
				setSwitching(true);
				void gui.send({ action: "switch", path: item.path }).finally(() => setSwitching(false));
			}} />)}
		{!visible.length && !unsaved && gui.sessions && <p className="history-hint">{search.trim() ? "没有匹配的会话" : "暂无历史会话"}</p>}
	</div>;
}
