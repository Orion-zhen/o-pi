import { memo, useCallback, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { listDepth, settle } from "@/ui/motion/transitions.ts";
import { Fade } from "@/ui/motion/animated.tsx";
import { ChevronRight, FolderClosed, RefreshCw } from "lucide-react";
import type { GuiSessionInfo } from "../../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import type { SessionListItem } from "./session-list.ts";
import type { SessionSearchResults } from "./use-session-search.ts";
import { Hint } from "@/ui/tooltip.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Button } from "@/ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible.tsx";
import { HistorySessionRow } from "./history-session-row.tsx";
import { ListScroll } from "@/ui/list-scroll.tsx";
import { useVirtualRows } from "@/ui/use-virtual-rows.ts";
import "./sessions.css";

const workspaceName = (cwd: string) => cwd.split(/[/\\]/).filter(Boolean).at(-1) || cwd || "未记录工作区";
interface HistoryGui {
	cwd: string;
	sessionRows: SessionListItem[];
	sessions: GuiSessionInfo[] | undefined;
	sessionsLoading: boolean;
	refreshSessions: () => Promise<void>;
	send: Send;
	canNavigate: boolean;
	connected: boolean;
}

export const SessionHistory = memo(function SessionHistory({ close, full = false, search, ...gui }: HistoryGui & {
	close: () => void; full?: boolean; search?: SessionSearchResults | undefined;
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
		{search?.state === "searching" && <p className="history-hint" role="status">正在搜索{search.total ? ` ${search.scanned}/${search.total}` : ""}…</p>}
		{search?.state === "error" && <p className="history-hint" role="alert">{search.message}</p>}
		<ListScroll className="history-scroll">
			<AnimatePresence initial={false} mode="wait">
			<Fade key={search ? "search" : "sessions"}>
			{!gui.sessions && <p className="history-hint" role="status">正在读取历史会话…</p>}
			{groups.filter(([cwd]) => full || cwd === gui.cwd).map(([cwd, items]) => {
				const rows = <SessionRows items={items} gui={gui} close={close} search={search} />;
				return full ? <Collapsible key={cwd} defaultOpen className="workspace-sessions">
					<Hint content={cwd}><CollapsibleTrigger asChild><Button variant="ghost" className="workspace-toggle">
						<ChevronRight className="workspace-chevron" /><FolderClosed /><span className="workspace-label">{workspaceName(cwd)}</span>
					</Button></CollapsibleTrigger></Hint>
					<CollapsibleContent>{rows}</CollapsibleContent>
				</Collapsible> : <div key={cwd}>{rows}</div>;
			})}
			</Fade>
			</AnimatePresence>
		</ListScroll>
	</section>;
});

function SessionRows({ items, gui, close, search }: {
	items: SessionListItem[]; gui: HistoryGui; close: () => void; search: SessionSearchResults | undefined;
}) {
	const [switching, setSwitching] = useState(false);
	const matches = useMemo(() => new Map(search?.hits.map((hit) => [hit.path, hit])), [search?.hits]);
	const searching = search !== undefined;
	const visible = useMemo(() => {
		if (!searching) return items;
		const titles: SessionListItem[] = [], content: SessionListItem[] = [];
		for (const item of items) {
			const match = item.path ? matches.get(item.path) : undefined;
			if (match) (match.source === "title" ? titles : content).push(item);
		}
		return [...titles, ...content];
	}, [items, searching, matches]);
	const visibleKeys = useMemo(() => new Set(visible.map((item) => item.key)), [visible]);
	const list = useVirtualRows<HTMLDivElement>(visible.length, (index) => visible[index]?.key ?? "", search ? 64 : 44);
	const open = useCallback((item: SessionListItem) => {
		close();
		if (item.selected) return;
		setSwitching(true);
		void gui.send({ action: "openSession", ...item.target }).finally(() => setSwitching(false));
	}, [close, gui.send]);
	const rows = list.rows.map((row) => {
		const item = visible[row.index];
		if (!item) return null;
		return <motion.div key={item.key} layout={list.windowed ? "position" : false} layoutDependency={visible}
			initial={false} {...(list.windowed ? {} : { animate: { height: "auto", paddingBottom: "var(--space-1)" }, exit: { height: 0, paddingBottom: 0 } })}
			transition={list.windowed ? settle : listDepth.transition}
			data-index={list.windowed ? row.index : undefined} className={list.windowed ? "history-virtual-row" : undefined}
			ref={list.windowed ? list.virtualizer.measureElement : undefined}
			style={{ minWidth: 0, ...(list.windowed ? { position: "absolute", top: row.start - list.virtualizer.options.scrollMargin, left: 0, width: "100%" } : { overflow: "clip" }) }}>
			<HistorySessionRow item={item} index={row.index} count={visible.length} disabled={switching || !gui.canNavigate} send={gui.send} animated={!list.windowed} open={open} match={matches.get(item.path ?? "")} />
		</motion.div>;
	});
	return <div ref={list.root} style={list.style} className="workspace-session-list">
		<AnimatePresence initial={false} custom={visibleKeys}>{rows}</AnimatePresence>
		{!visible.length && gui.sessions && (!search || search.state === "done") && <p className="history-hint">{search ? "没有匹配的会话" : "暂无历史会话"}</p>}
	</div>;
}
