import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Fade } from "@/ui/motion/animated.tsx";
import { fade, listDepth, listDeparture, settle } from "@/ui/motion/transitions.ts";
import { ChevronsUpDown, FolderOpen, Home, Shield } from "lucide-react";
import { Check, FolderOpen as FolderOpenData } from "lucide";
import { MorphIcon } from "morphicons/react";
import { FilledShield, StatusDot } from "@/ui/icon-shapes.ts";
import type { GlobalQuery, Query } from "../../../shared/protocol/queries.ts";
import type { GuiWorkspaceInfo } from "../../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import { Button } from "@/ui/button.tsx";
import { SearchInput } from "@/ui/search-input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover.tsx";
import { DirectoryBrowser } from "./directory-browser.tsx";
import { Hint } from "@/ui/tooltip.tsx";
import { ConfirmAction } from "@/ui/confirm-action.tsx";
import { ListScroll } from "@/ui/list-scroll.tsx";
import { workspaceActivities, type ActivityState, type SessionActivity } from "@/features/sessions/use-session-activity.ts";
import { ActivityBorder } from "@/features/sessions/activity-border.tsx";
import "./workspace-picker.css";

interface WorkspacePickerView {
	cwd: string;
	activity: SessionActivity[];
	workspaceRoot: string;
	workspaces: GuiWorkspaceInfo[];
	send: Send;
	connected: boolean;
	canNavigate: boolean;
	globalQuery: Query<GlobalQuery>;
	error: string;
	setError: (message: string) => void;
}

export function WorkspacePicker({ gui, close, compact = false }: { gui: WorkspacePickerView; close: () => void; compact?: boolean }) {
	const [expanded, setExpanded] = useState(false);
	const [browsing, setBrowsing] = useState(false);
	const [filter, setFilter] = useState("");
	const [pending, setPending] = useState(false);
	const cwd = gui.cwd;
	const elsewhere = gui.activity.filter((item) => item.cwd !== cwd);
	const elsewhereWaiting = elsewhere.some((item) => item.state === "waiting");
	const state: ActivityState = elsewhereWaiting ? "waiting"
		: elsewhere.some((item) => item.unread) ? "unread"
		: elsewhere.some((item) => item.state === "running" || item.state === "loading") ? "running" : "idle";
	const status = state === "waiting" ? "有会话等待审批" : state === "unread" ? "有未读结果" : "其他工作区有会话运行中";
	const workspaces = gui.workspaces;
	const activity = useMemo(() => workspaceActivities(gui.activity), [gui.activity]);
	const open = async (directory: string) => {
		setPending(true);
		try {
			if (directory === cwd || await gui.send({ action: "workspace", path: directory })) {
				setExpanded(false);
				setBrowsing(false);
				close();
			}
		} finally { setPending(false); }
	};
	const disabled = pending || !gui.canNavigate;
	return <>
		<Popover open={expanded} onOpenChange={(value) => { setExpanded(value); setFilter(""); }}>
			<Hint content={cwd} disabled={expanded}><PopoverTrigger asChild><Button variant="outline" role="combobox" aria-label="工作区" aria-expanded={expanded}
				className="workspace-select activity-frame" aria-description={state === "idle" ? cwd : `${cwd}\n${status}`} disabled={disabled}>
				<ActivityBorder state={state} />
				{compact ? <MorphIcon icon={elsewhereWaiting ? FilledShield : FolderOpenData} spring="smooth" size="1em"
					className={elsewhereWaiting ? "approval-marker" : undefined} {...(elsewhereWaiting ? { label: "其他工作区等待审批" } : {})} /> : <FolderOpen />}
				{!compact && <span>{cwd.split(/[/\\]/).filter(Boolean).at(-1) || "选择工作区"}</span>}
				{!compact && elsewhereWaiting && <Shield className="approval-marker" fill="currentColor" role="img" aria-label="其他工作区等待审批" />}
				{!compact && <ChevronsUpDown />}
			</Button></PopoverTrigger></Hint>
			<PopoverContent className="workspace-options">
				<SearchInput aria-label="筛选工作区" placeholder="筛选工作区" value={filter} onValueChange={setFilter} />
				<ListScroll>{(refreshScroll) =>
				<div role="listbox" aria-label="工作区列表" className="workspace-list">
					<AnimatePresence initial={false} onExitComplete={refreshScroll}>
					{workspaces.filter(({ path }) => path.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map(({ path, exists, home }) => {
						const state = activity.get(path) ?? "idle";
						const status = state === "running" ? "运行中" : state === "waiting" ? "等待审批" : "有未读结果";
						return <motion.div layout="position" transition={settle} onLayoutAnimationComplete={refreshScroll} style={{ flexShrink: 0, minWidth: 0 }} key={path}>
							<Fade animate={{ ...fade.animate, ...listDepth.visible }} exit={listDeparture} className="workspace-option-row overlay-list-row">
								<Hint content={path}><Button role="option" aria-label={path} aria-selected={path === cwd} variant="ghost"
									disabled={disabled || !exists} aria-description={state === "idle" ? undefined : status} onClick={() => void open(path)}>
									<span className="workspace-option-label"><span className="workspace-option-path"><bdi dir="ltr">{home
										? <><span className="workspace-option-home"><Home aria-hidden="true" />{home.username}</span>{home.suffix}</>
										: path}</bdi></span>{!exists && <small>目录不存在</small>}</span>
									{(path === cwd || state !== "idle") && <MorphIcon icon={path === cwd ? Check : state === "waiting" ? FilledShield : StatusDot}
										spring="smooth" size="1em" data-activity={state} {...(path === cwd ? {} : { label: status })}
										className={path === cwd ? undefined : state === "waiting" ? "approval-marker" : "workspace-option-status"} />}
								</Button></Hint>
								{path !== gui.workspaceRoot && path !== cwd && state === "idle" && <div className="row-actions">
									<ConfirmAction label={`移除工作区 ${path}`} tooltip="清空会话 · 保留文件"
										disabled={disabled} confirm={() => gui.send({ action: "removeWorkspace", path })} />
								</div>}
							</Fade>
						</motion.div>;
					})}
					</AnimatePresence>
				</div>
				}</ListScroll>
				<Button variant="outline" disabled={disabled} onClick={() => {
					if (window.opi) {
						void window.opi.chooseDirectory().then(async (directory) => { if (directory) await open(directory); })
							.catch((error: unknown) => gui.setError(String(error)));
					} else { setExpanded(false); setBrowsing(true); }
				}}><FolderOpen />选择目录</Button>
			</PopoverContent>
		</Popover>
		<AnimatePresence>
		{browsing && <DirectoryBrowser gui={gui} initial={cwd} select={open} close={() => setBrowsing(false)} />}
		</AnimatePresence>
	</>;
}
