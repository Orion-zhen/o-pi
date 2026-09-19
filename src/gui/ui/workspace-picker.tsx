import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { Fade } from "./components/animated";
import { fade, settle } from "./lib/motion";
import { Check, ChevronsUpDown, FolderOpen, Shield } from "lucide-react";
import type { SidebarView } from "./use-gui.ts";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { DirectoryBrowser } from "./directory-browser.tsx";
import { ConfirmAction } from "./confirm-action.tsx";
import { ListScroll } from "./components/list-scroll";
import { workspaceActivity, type ActivityState } from "./use-session-activity.ts";
import { ActivityBorder } from "./activity-border.tsx";

export function WorkspacePicker({ gui, close, compact = false }: { gui: Pick<SidebarView, "cwd" | "activity" | "workspaceRoot" | "workspaces" | "send" | "connected" | "canNavigate" | "globalQuery" | "error" | "setError">; close: () => void; compact?: boolean }) {
	const [expanded, setExpanded] = useState(false);
	const [browsing, setBrowsing] = useState(false);
	const [filter, setFilter] = useState("");
	const [pending, setPending] = useState(false);
	const cwd = gui.cwd;
	const state: ActivityState = gui.activity.some((item) => item.state === "waiting") ? "waiting"
		: gui.activity.some((item) => item.unread) ? "unread"
		: gui.activity.some((item) => item.cwd !== cwd && (item.state === "running" || item.state === "loading")) ? "running" : "idle";
	const status = state === "waiting" ? "有会话等待审批" : state === "unread" ? "有未读结果" : "其他工作区有会话运行中";
	const elsewhereWaiting = gui.activity.some((item) => item.cwd !== cwd && item.state === "waiting");
	const workspaces = gui.workspaces;
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
			<PopoverTrigger asChild><Button variant="outline" role="combobox" aria-label="工作区" aria-expanded={expanded}
				className="workspace-select activity-frame" title={state === "idle" ? cwd : `${cwd}\n${status}`} disabled={disabled}>
				<ActivityBorder state={state} />
				{(!compact || !elsewhereWaiting) && <FolderOpen />}
				{!compact && <span>{cwd.split(/[/\\]/).filter(Boolean).at(-1) || "选择工作区"}</span>}
				{elsewhereWaiting && <Shield className="approval-marker" fill="currentColor" role="img" aria-label="其他工作区等待审批" />}
				{!compact && <ChevronsUpDown />}
			</Button></PopoverTrigger>
			<PopoverContent className="workspace-options">
				<Input aria-label="筛选工作区" placeholder="筛选工作区" value={filter} onChange={(event) => setFilter(event.target.value)} />
				<ListScroll>
				<div role="listbox" aria-label="工作区列表" className="workspace-list">
					<AnimatePresence initial={false}>
					{workspaces.filter(({ path }) => path.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map(({ path, exists }) => {
						const state = workspaceActivity(gui.activity, path);
						const status = state === "running" ? "运行中" : state === "waiting" ? "等待审批" : "有未读结果";
						return <Fade layout="position" transition={{ ...fade.transition, layout: settle }} className="workspace-option-row overlay-list-row" key={path}>
							<Button role="option" aria-label={path} aria-selected={path === cwd} variant="ghost"
								disabled={disabled || !exists} title={state === "idle" ? path : `${path}\n${status}`} onClick={() => void open(path)}>
								<span className="workspace-option-label"><span className="workspace-option-path"><bdi dir="ltr">{path}</bdi></span>{!exists && <small>目录不存在</small>}</span>
								{path === cwd ? <Check /> : state === "waiting" ? <Shield className="approval-marker" fill="currentColor" role="img" aria-label={status} />
									: state !== "idle" && <span className="workspace-option-status" data-activity={state} role="img" aria-label={status} />}
							</Button>
							{path !== gui.workspaceRoot && path !== cwd && state === "idle" && <div className="row-actions">
								<ConfirmAction label={`移除工作区 ${path}`} hint="永久删除该工作区全部会话，保留项目目录和文件"
									disabled={disabled} confirm={() => gui.send({ action: "removeWorkspace", path })} />
							</div>}
						</Fade>;
					})}
					</AnimatePresence>
				</div>
				</ListScroll>
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
