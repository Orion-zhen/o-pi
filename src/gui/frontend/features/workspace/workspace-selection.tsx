import { useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Home, FolderOpen, Search } from "lucide-react";
import { Check } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { GlobalQuery, Query } from "../../../shared/protocol/queries.ts";
import type { GuiWorkspaceInfo } from "../../../shared/protocol/state.ts";
import type { GlobalSend } from "@/connection/connection.ts";
import { useOperation } from "@/connection/use-operation.ts";
import { Fade } from "@/ui/motion/animated.tsx";
import { fade, listDepth, listDeparture } from "@/ui/motion/transitions.ts";
import { FilledShield, StatusDot } from "@/ui/icon-shapes.ts";
import { Button } from "@/ui/button.tsx";
import { Feedback } from "@/ui/feedback.tsx";
import { SearchInput } from "@/ui/search-input.tsx";
import { Popover, PopoverContent } from "@/ui/popover.tsx";
import { Hint } from "@/ui/tooltip.tsx";
import { ConfirmAction } from "@/ui/confirm-action.tsx";
import { ListScroll } from "@/ui/list-scroll.tsx";
import { workspaceActivities, type SessionActivity } from "@/features/sessions/use-session-activity.ts";
import { DirectoryBrowser } from "./directory-browser.tsx";
import "./workspace-picker.css";

export interface WorkspaceSelectionView {
	cwd: string;
	activity: SessionActivity[];
	workspaceRoot: string;
	workspaces: GuiWorkspaceInfo[];
	globalSend: GlobalSend;
	canNavigate: boolean;
	globalQuery: Query<GlobalQuery>;
}

export type WorkspaceSelectionMode = "closed" | "list" | "browser";

export function WorkspaceSelection({ gui, mode, onModeChange, purpose, select, children, onCloseAutoFocus }: {
	gui: WorkspaceSelectionView;
	mode: WorkspaceSelectionMode;
	onModeChange: (mode: WorkspaceSelectionMode) => void;
	purpose: "navigate" | "restore";
	select: (directory: string) => Promise<void>;
	children: (disabled: boolean) => ReactNode;
	onCloseAutoFocus?: ComponentProps<typeof PopoverContent>["onCloseAutoFocus"];
}) {
	const [filter, setFilter] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const activity = useMemo(() => workspaceActivities(gui.activity), [gui.activity]);
	const changeMode = (mode: WorkspaceSelectionMode) => { onModeChange(mode); setFilter(""); };
	const reportError = (error: unknown) => setError(error instanceof Error ? error.message : String(error));
	const choose = async (directory: string) => {
		setPending(true); setError("");
		try {
			await select(directory);
			changeMode("closed");
		} finally { setPending(false); }
	};
	const removal = useOperation((path: string) => gui.globalSend({ action: "removeWorkspace", path }));
	const disabled = pending || removal.pending || !gui.canNavigate;
	return <>
		<Popover open={mode === "list"} onOpenChange={(open) => changeMode(open ? "list" : "closed")}>
			{children(disabled)}
			<PopoverContent className="workspace-options" onOpenAutoFocus={purpose === "navigate" ? (event) => event.preventDefault() : undefined} onCloseAutoFocus={onCloseAutoFocus}>
				<SearchInput icon={Search} aria-label="筛选工作区" placeholder="筛选工作区" value={filter} onValueChange={setFilter} />
				<ListScroll>
				<div role="listbox" aria-label="工作区列表" className="workspace-list">
					<AnimatePresence initial={false}>
					{gui.workspaces.filter(({ path }) => path.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map(({ path, exists, home }) => {
						const state = activity.get(path) ?? "idle";
						const status = state === "running" ? "运行中" : state === "waiting" ? "等待审批" : "有未读结果";
						return <motion.div initial={false} animate={{ height: "auto", paddingBottom: "var(--space-1)" }}
							exit={{ height: 0, paddingBottom: 0 }} transition={listDepth.transition} style={{ flexShrink: 0, minWidth: 0, overflow: "clip" }} key={path}>
							<Fade animate={{ ...fade.animate, ...listDepth.visible }} exit={listDeparture} className="workspace-option-row overlay-list-row">
								<Hint content={path}><Button role="option" aria-label={path} aria-selected={path === gui.cwd} variant="ghost"
									disabled={disabled || purpose === "restore" && !exists} aria-description={state === "idle" ? undefined : status} onClick={() => void choose(path).catch(reportError)}>
									<span className="workspace-option-label"><span className="workspace-option-path"><bdi dir="ltr">{home
										? <><span className="workspace-option-home"><Home aria-hidden="true" />{home.username}</span>{home.suffix}</>
										: path}</bdi></span>{!exists && <small>目录不存在</small>}</span>
									{(path === gui.cwd || state !== "idle") && <MorphIcon icon={path === gui.cwd ? Check : state === "waiting" ? FilledShield : StatusDot}
										spring="smooth" size="1em" data-activity={state} {...(path === gui.cwd ? {} : { label: status })}
										className={path === gui.cwd ? undefined : state === "waiting" ? "approval-marker" : "workspace-option-status"} />}
								</Button></Hint>
								{purpose === "navigate" && path !== gui.workspaceRoot && path !== gui.cwd && state === "idle" && <div className="row-actions">
									<ConfirmAction label={`移除工作区 ${path}`} tooltip="删除全部会话"
										disabled={disabled} confirm={() => removal.run(path)} />
								</div>}
							</Fade>
						</motion.div>;
					})}
					</AnimatePresence>
				</div>
				</ListScroll>
				<Feedback compact message={error || removal.error} tone="error" />
				<Button variant="outline" disabled={disabled} onClick={() => {
					if (window.opi) {
						void window.opi.chooseDirectory().then(async (directory) => { if (directory) await choose(directory); })
							.catch(reportError);
					} else changeMode("browser");
				}}><FolderOpen />选择目录</Button>
			</PopoverContent>
		</Popover>
		<AnimatePresence>
		{mode === "browser" && <DirectoryBrowser gui={gui} initial={gui.workspaces.some((workspace) => workspace.path === gui.cwd && !workspace.exists) ? gui.workspaceRoot : gui.cwd}
			select={choose} close={() => changeMode("closed")} />}
		</AnimatePresence>
	</>;
}
