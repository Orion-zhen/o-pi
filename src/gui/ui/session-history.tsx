import { useMemo, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ChevronRight, FolderClosed, RefreshCw } from "lucide-react";
import type { GuiSessionInfo } from "../contract.ts";
import type { SidebarView } from "./use-gui.ts";
import { IconButton } from "./components/icon-button";
import { Button } from "./components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { HistorySessionRow } from "./history-session-row.tsx";
import { ListScroll } from "./components/list-scroll";
import { useVirtualRows } from "./use-virtual-rows.ts";
import "./sessions.css";

const workspaceName = (cwd: string) => cwd.split(/[/\\]/).filter(Boolean).at(-1) || cwd || "未记录工作区";
type HistoryGui = Pick<SidebarView, "snapshot" | "sessions" | "sessionsLoading" | "refreshSessions" | "send" | "canChangeSession" | "connected">;

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
		<ListScroll className="history-scroll">
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
		</ListScroll>
	</section>;
}

function SessionRows({ cwd, items, gui, close, search }: {
	cwd: string; items: GuiSessionInfo[]; gui: HistoryGui; close: () => void; search: string;
}) {
	const [switching, setSwitching] = useState(false);
	const { snapshot } = gui;
	const active = useMemo(() => items.find((item) => item.path === snapshot?.sessionFile), [items, snapshot?.sessionFile]);
	const blocked = switching || !gui.canChangeSession;
	const visible = useMemo(() => {
		const needle = search.trim().toLocaleLowerCase();
		const rows: { key: string; path: string | null; title: string; modified: string | undefined; selected: boolean }[] = items.map((item) => ({ key: item.path, path: item.path,
			title: item === active && snapshot?.name ? snapshot.name : item.title, modified: item.modified, selected: item === active }));
		if (cwd === snapshot?.cwd && !active) rows.unshift({ key: snapshot.sessionId, path: snapshot.sessionFile, title: snapshot.name || "新会话", modified: undefined, selected: true });
		return rows.filter((row) => row.title.toLocaleLowerCase().includes(needle));
	}, [items, active, cwd, snapshot, search]);
	const list = useVirtualRows<HTMLDivElement>(visible.length, (index) => visible[index]?.key ?? "", 44);
	const rows = list.rows.map((row) => {
		const item = visible[row.index];
		if (!item) return null;
		const content = <HistorySessionRow key={item.key} title={item.title} path={item.path} modified={item.modified}
			selected={item.selected} disabled={blocked} send={gui.send} animated={!list.windowed} open={() => {
				close();
				if (item.selected || !item.path) return;
				setSwitching(true);
				void gui.send({ action: "switch", path: item.path }).finally(() => setSwitching(false));
			}} />;
		return list.windowed ? <div key={row.key} data-index={row.index} className="history-virtual-row" ref={list.virtualizer.measureElement} style={list.rowStyle(row.start)}>{content}</div> : content;
	});
	return <div ref={list.root} style={list.style} className="workspace-session-list">
		{list.windowed ? rows : <AnimatePresence initial={false}>{rows}</AnimatePresence>}
		{!visible.length && gui.sessions && <p className="history-hint">{search.trim() ? "没有匹配的会话" : "暂无历史会话"}</p>}
	</div>;
}
