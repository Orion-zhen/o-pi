import { useEffect, useMemo, useState } from "react";
import { ChevronRight, FolderClosed, FolderOpen, MessageSquare, RefreshCw } from "lucide-react";
import type { GuiSessionInfo } from "../contract.ts";
import type { GuiView } from "./use-gui.ts";
import { IconButton } from "./components/icon-button";
import { Button } from "./components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { HistoryMenu } from "./history-menu.tsx";
import "./sessions.css";

const workspaceName = (cwd: string) => cwd.split(/[/\\]/).filter(Boolean).at(-1) || cwd || "未记录工作区";
const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });
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
	const others = groups.filter(([cwd]) => cwd !== snapshot?.cwd);
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
			{full ? (
				groups.map(renderGroup)
			) : (
				<>
					{current.map(renderGroup)}
					{others.length > 0 && (
						<Collapsible key={snapshot?.cwd ?? "unselected"} className="other-workspaces">
							<CollapsibleTrigger asChild>
								<Button variant="ghost" className="other-workspaces-toggle">
									<ChevronRight />
									其他工作区 ({others.length})
								</Button>
							</CollapsibleTrigger>
							<CollapsibleContent>{others.map(renderGroup)}</CollapsibleContent>
						</Collapsible>
					)}
				</>
			)}
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
				<HistoryMenu
					label={`工作区 ${cwd} 的更多操作`}
					action={{ action: "deleteWorkspace", cwd }}
					disabled={blocked}
					send={gui.send}
					close={close}
				/>
			</div>
			<CollapsibleContent>
				<div className="workspace-session-list">
					{current && !active && (
						<div className="history-session-row" data-current="true">
							<Button variant="ghost" className="history-session" aria-current="page" onClick={close}>
								<MessageSquare />
								<span className="history-session-title">{snapshot?.name || "新会话"}</span>
							</Button>
							{snapshot?.sessionFile && (
								<HistoryMenu
									label={`会话 ${snapshot.name || "新会话"} 的更多操作`}
									action={{ action: "deleteSession", path: snapshot.sessionFile }}
									disabled={blocked}
									send={gui.send}
									close={close}
								/>
							)}
						</div>
					)}
					{visible.map((item) => {
						const selected = item === active;
						const title = selected && snapshot?.name ? snapshot.name : item.title;
						return (
							<div className="history-session-row" data-current={selected} key={item.path}>
								<Button
									variant="ghost"
									className="history-session"
									aria-label={title}
									aria-current={selected ? "page" : undefined}
									title={`${title}\n${new Date(item.modified).toLocaleString("zh-CN")}`}
									disabled={blocked}
									onClick={() => {
										if (selected) {
											close();
											return;
										}
										setSwitching(true);
										close();
										void gui.send({ action: "switch", path: item.path }).finally(() => setSwitching(false));
									}}
								>
									<MessageSquare />
									<span className="history-session-title">{title}</span>
									<time dateTime={item.modified}>{dateFormat.format(new Date(item.modified))}</time>
								</Button>
								<HistoryMenu
									label={`会话 ${title} 的更多操作`}
									action={{ action: "deleteSession", path: item.path }}
									disabled={blocked}
									send={gui.send}
									close={close}
								/>
							</div>
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
