import { memo, useMemo } from "react";
import { useOperation } from "@/connection/use-operation.ts";
import { AnimatePresence, motion } from "motion/react";
import { listDepth, settle } from "@/ui/motion/transitions.ts";
import { Fade } from "@/ui/motion/animated.tsx";
import { useStartupLists } from "@/app/welcome/startup-entrance.tsx";
import { ChevronRight, FolderClosed, RefreshCw } from "lucide-react";
import type { GuiSessionInfo } from "../../../shared/protocol/state.ts";
import type { GlobalSend } from "@/connection/connection.ts";
import type { SessionListItem } from "./session-list.ts";
import type { SessionSearchResults } from "./use-session-search.ts";
import { Hint } from "@/ui/tooltip.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Button } from "@/ui/button.tsx";
import { Feedback } from "@/ui/feedback.tsx";
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
	send: GlobalSend;
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
		<Feedback message={search?.state === "searching" ? `正在搜索${search.total ? ` ${search.scanned}/${search.total}` : ""}…` : ""} />
		<Feedback compact message={search?.state === "error" ? search.message : ""} tone="error" />
		<ListScroll className="history-scroll">
			<AnimatePresence initial={false} mode="wait">
			<Fade key={search ? "search" : "sessions"}>
			<Feedback message={!gui.sessions || full && gui.sessionsLoading ? "正在读取历史会话…" : ""} />
			{groups.filter(([cwd]) => full || cwd === gui.cwd).map(([cwd, items]) => {
				const rows = <SessionRows items={items} gui={gui} close={close} search={search} startup={!full && !search && gui.sessions !== undefined} />;
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

function SessionRows({ items, gui, close, search, startup }: {
	items: SessionListItem[]; gui: HistoryGui; close: () => void; search: SessionSearchResults | undefined; startup: boolean;
}) {
	const { run: open, pending: switching, error } = useOperation(async (item: SessionListItem) => {
		if (!item.selected) await gui.send({ action: "openSession", ...item.target });
	}, close);
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
	const list = useVirtualRows<HTMLDivElement>(visible.length, (index) => visible[index]?.key ?? "", search ? 64 : 44, 20);
	const { lists, ...interaction } = useStartupLists("sessions", startup, list.rows.map((row) => String(row.key)), list.root);
	const rows = list.rows.map((row) => {
		const item = visible[row.index];
		if (!item) return null;
		// Motion 复用行节点时不会补调新增的 ref，普通布局也需登记测量节点。
		return <motion.div key={item.key} layout={list.windowed ? "position" : false} layoutDependency={visible}
			initial={false} {...(list.windowed ? {} : { animate: { height: "auto", paddingBottom: "var(--space-1)" }, exit: "exit" })}
			variants={{ exit: (visible: ReadonlySet<string>) => visible.has(item.key) ? { transition: { duration: 0 } } : { height: 0, paddingBottom: 0 } }}
			transition={list.windowed ? settle : listDepth.transition}
			data-index={row.index} className={list.windowed ? "history-virtual-row" : undefined}
			ref={list.virtualizer.measureElement}
			style={{ minWidth: 0, ...list.rowStyle, ...(!list.windowed && { overflow: "clip" }) }}>
			<HistorySessionRow item={item} lists={lists} disabled={switching || !gui.connected} send={gui.send} animated={!list.windowed} open={open} match={matches.get(item.path ?? "")} />
		</motion.div>;
	});
	return <><Feedback compact message={error} tone="error" /><div ref={list.containerRef} style={list.style} className="workspace-session-list" {...interaction}>
		<AnimatePresence initial={Boolean(lists)} custom={visibleKeys}>{rows}</AnimatePresence>
		{!visible.length && gui.sessions && (!search || search.state === "done") && <p className="history-hint">{search ? "没有匹配的会话" : "暂无历史会话"}</p>}
	</div></>;
}
