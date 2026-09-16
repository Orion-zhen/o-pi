import { useEffect, useMemo, useState } from "react";
import { ChevronRight, FolderClosed, FolderOpen, RefreshCw } from "lucide-react";
import type { GuiSessionInfo } from "../contract.ts";
import type { GuiView } from "./use-gui.ts";
import { IconButton } from "./components/icon-button";
import { Button } from "./components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { HistorySessionRow } from "./history-session-row.tsx";
import "./sessions.css";

const workspaceName = (cwd: string) => cwd.split(/[/\\]/).filter(Boolean).at(-1) || cwd || "未记录工作区";
const recentCount = 6;

type HistoryGui = Pick<
	GuiView,
	"snapshot" | "sessions" | "sessionsLoading" | "refreshSessions" | "send" | "running" | "status"
>;

export function SessionHistory({ gui, close, full = false }: { gui: HistoryGui; close: () => void; full?: boolean }) {
	const { snapshot, sessions } = gui;
	const groups = useMemo(() => {
		const result = new Map<string, GuiSessionInfo[]>();
		if (snapshot) result.set(snapshot.cwd, []);
		for (const session of sessions ?? []) {
			const group = result.get(session.cwd);
			if (group) group.push(session);
			else result.set(session.cwd, [session]);
		}
		return [...result];
	}, [sessions, snapshot?.cwd]);
	const names = new Map<string, number>();
	for (const [cwd] of groups) names.set(workspaceName(cwd), (names.get(workspaceName(cwd)) ?? 0) + 1);
	const renderGroup = ([cwd, items]: [string, GuiSessionInfo[]]) => (
		<WorkspaceSessions
			key={cwd}
			cwd={cwd}
			items={items}
			gui={gui}
			close={close}
			full={full}
			duplicateName={(names.get(workspaceName(cwd)) ?? 0) > 1}
		/>
	);
	const current = groups.filter(([cwd]) => cwd === snapshot?.cwd);
		return (
		<section className="session-history" aria-label="历史会话">
			<div className="history-heading">
				<h2>{full ? "全部会话" : "工作区"}</h2>
				<IconButton
					label="刷新会话"
					disabled={gui.sessionsLoading || gui.status !== "已连接"}
					onClick={() => void gui.refreshSessions()}
				>
					<RefreshCw className={gui.sessionsLoading ? "animate-spin" : undefined} />
				</IconButton>
			</div>
			{!sessions && (
				<p className="history-hint" role="status">
					正在读取历史会话…
				</p>
			)}
			{(full ? groups : current).map(renderGroup)}
		</section>
	);
}

function WorkspaceSessions({
	cwd,
	items,
	gui,
	close,
	full,
	duplicateName,
}: {
	cwd: string;
	items: GuiSessionInfo[];
	gui: HistoryGui;
	close: () => void;
	full: boolean;
	duplicateName: boolean;
}) {
	const { snapshot } = gui;
	const current = snapshot?.cwd === cwd;
	const [open, setOpen] = useState(current || full);
	const [showAll, setShowAll] = useState(full);
	const [switching, setSwitching] = useState(false);
	useEffect(() => {
		if (current) setOpen(true);
	}, [current]);
	const active = items.find((item) => item.path === snapshot?.sessionFile);
	let visible = showAll ? items : items.slice(0, recentCount);
	if (!showAll && active && !visible.includes(active)) visible = [...visible.slice(0, recentCount - 1), active];
	const blocked =
		switching ||
		gui.status !== "已连接" ||
		snapshot === undefined ||
		Boolean(snapshot?.busy) ||
		gui.running ||
		Boolean(snapshot?.retrying);
	return (
		<Collapsible open={open} onOpenChange={setOpen} className="workspace-sessions" data-current={current}>
			<div className="workspace-heading">
				<CollapsibleTrigger asChild>
					<Button
						variant="ghost"
						className="workspace-toggle"
						aria-label={`工作区 ${cwd || "未记录工作区"}`}
						title={cwd}
					>
						<ChevronRight className="workspace-chevron" />
						{open ? <FolderOpen /> : <FolderClosed />}
						<span className="workspace-label">
							<span>{workspaceName(cwd)}</span>
							{duplicateName && (
								<small>
									<bdi dir="ltr">{cwd}</bdi>
								</small>
							)}
						</span>
					</Button>
				</CollapsibleTrigger>
			</div>
			<CollapsibleContent>
				<div className="workspace-session-list">
					{current && !active && (
						<HistorySessionRow key={snapshot?.sessionId} title={snapshot?.name || "新会话"}
							path={snapshot?.sessionFile ?? null} selected disabled={blocked} send={gui.send} open={close} />
					)}
					{visible.map((item) => {
						const selected = item === active;
						const title = selected && snapshot?.name ? snapshot.name : item.title;
						return (
							<HistorySessionRow key={item.path} title={title} path={item.path} modified={item.modified}
								selected={selected} disabled={blocked} send={gui.send} open={() => {
									close();
									if (selected) return;
									setSwitching(true);
									void gui.send({ action: "switch", path: item.path }).finally(() => setSwitching(false));
								}} />
						);
					})}
					{items.length === 0 && gui.sessions && <p className="history-hint">暂无历史会话</p>}
					{items.length > recentCount && !full && (
						<Button variant="ghost" size="sm" className="history-more" onClick={() => setShowAll(!showAll)}>
							{showAll ? "收起" : `显示更多 (${items.length - visible.length})`}
						</Button>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
