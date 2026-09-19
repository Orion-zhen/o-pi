import { useMemo, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ChevronRight, FolderClosed, RefreshCw } from "lucide-react";
import type { SidebarView } from "./use-gui.ts";
import type { SessionListItem } from "./session-list.ts";
import { IconButton } from "./components/icon-button";
import { Button } from "./components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { HistorySessionRow } from "./history-session-row.tsx";
import { ListScroll } from "./components/list-scroll";
import { useVirtualRows } from "./use-virtual-rows.ts";
import "./sessions.css";

const workspaceName = (cwd: string) => cwd.split(/[/\\]/).filter(Boolean).at(-1) || cwd || "未记录工作区";
type HistoryGui = Pick<SidebarView, "cwd" | "sessionRows" | "sessions" | "sessionsLoading" | "refreshSessions" | "send" | "canNavigate" | "connected">;

export function SessionHistory({ gui, close, full = false, search = "" }: {
	gui: HistoryGui; close: () => void; full?: boolean; search?: string;
}) {
	const groups = useMemo(() => {
		const result = new Map<string, SessionListItem[]>();
		if (gui.cwd) result.set(gui.cwd, []);
		for (const row of gui.sessionRows) {
			const group = result.get(row.cwd);
			if (group) group.push(row); else result.set(row.cwd, [row]);
		}
		return [...result];
	}, [gui.sessionRows, gui.cwd]);
	return <section className={`session-history${full ? "" : " session-history-flat"}`} aria-label="历史会话">
		<div className="history-heading">
			<h2>{full ? "全部会话" : "会话"}</h2>
			<IconButton label="刷新会话" disabled={gui.sessionsLoading || !gui.connected} onClick={() => void gui.refreshSessions()}>
				<RefreshCw className={gui.sessionsLoading ? "animate-spin" : undefined} />
			</IconButton>
		</div>
		<ListScroll className="history-scroll">
			{!gui.sessions && <p className="history-hint" role="status">正在读取历史会话…</p>}
			{groups.filter(([cwd]) => full || cwd === gui.cwd).map(([cwd, items]) => {
				const rows = <SessionRows items={items} gui={gui} close={close} search={search} />;
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

function SessionRows({ items, gui, close, search }: {
	items: SessionListItem[]; gui: HistoryGui; close: () => void; search: string;
}) {
	const [switching, setSwitching] = useState(false);
	const visible = useMemo(() => items.filter((item) => item.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [items, search]);
	const list = useVirtualRows<HTMLDivElement>(visible.length, (index) => visible[index]?.key ?? "", 44);
	const rows = list.rows.map((row) => {
		const item = visible[row.index];
		if (!item) return null;
		const activity = item.activity;
		const content = <HistorySessionRow key={item.key} title={item.title} path={item.path} modified={item.modified || undefined}
			selected={item.selected} disabled={switching || !gui.canNavigate} busy={activity !== undefined && activity.state !== "idle"}
			waiting={activity?.state === "waiting"} unread={activity?.unread === true} send={gui.send} animated={!list.windowed} open={() => {
				close();
				if (item.selected) return;
				setSwitching(true);
				void gui.send({ action: "openSession", ...item.target }).finally(() => setSwitching(false));
			}} />;
		return list.windowed ? <div key={row.key} data-index={row.index} className="history-virtual-row" ref={list.virtualizer.measureElement} style={list.rowStyle(row.start)}>{content}</div> : content;
	});
	return <div ref={list.root} style={list.style} className="workspace-session-list">
		{list.windowed ? rows : <AnimatePresence initial={false}>{rows}</AnimatePresence>}
		{!visible.length && gui.sessions && <p className="history-hint">{search.trim() ? "没有匹配的会话" : "暂无历史会话"}</p>}
	</div>;
}
