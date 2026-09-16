import {
	Activity,
	ChevronDown,
	FolderOpen,
	KeyRound,
	PanelLeftClose,
	PanelLeftOpen,
	Plus,
	RefreshCw,
	Settings2,
	SlidersHorizontal,
	Terminal,
} from "lucide-react";
import type { GuiView } from "./use-gui.ts";
import type { GuiAction } from "../contract.ts";
import { SessionHistory } from "./session-history.tsx";
import { IconButton } from "./components/icon-button";
import { Button } from "./components/ui/button";
import { WorkspacePicker } from "./workspace-picker.tsx";
import { SheetClose, SheetContent, SheetTitle } from "./components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";

export function Sidebar({
	gui,
	collapsed,
	toggle,
	close,
}: {
	gui: GuiView;
	collapsed: boolean;
	toggle: () => void;
	close: () => void;
}) {
	const act = (action: GuiAction) => {
		close();
		void gui.send(action);
	};
	const project = gui.snapshot?.cwd.split(/[/\\]/).filter(Boolean).at(-1) ?? "工作空间";
	const content = (compact: boolean, mobile: boolean) => (
		<>
			<div className="sidebar-brand">
				{!compact && (
					<span className="brand">
						<Terminal aria-hidden="true" />
						<span>o-pi</span>
						<small>workspace</small>
					</span>
				)}
				{mobile ? (
					<SheetClose asChild>
						<Button variant="ghost" size="icon" aria-label="关闭菜单" title="关闭菜单">
							<PanelLeftClose />
						</Button>
					</SheetClose>
				) : (
					<IconButton label={compact ? "展开侧栏" : "收起侧栏"} onClick={toggle} aria-expanded={!compact}>
						{compact ? <PanelLeftOpen /> : <PanelLeftClose />}
					</IconButton>
				)}
			</div>
			<div className="sidebar-scroll">
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="outline"
							className="new-session"
							aria-label="新建会话"
							disabled={!gui.snapshot || gui.snapshot.busy || gui.running || gui.status !== "已连接"}
							onClick={() => {
								void gui.send({ action: "new" });
								close();
							}}
						>
							<Plus />
							{!compact && <span>新建会话</span>}
						</Button>
					</TooltipTrigger>
					{compact && <TooltipContent side="right">新建会话</TooltipContent>}
				</Tooltip>
				{!compact && (
					<details className="workspace-picker">
						<summary>
							<FolderOpen aria-hidden="true" />
							<span title={gui.snapshot?.cwd}>{project}</span>
							<ChevronDown aria-hidden="true" />
						</summary>
						<WorkspacePicker gui={gui} close={close} />
					</details>
				)}
				<nav aria-label="工作空间导航" className="sidebar-nav">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								aria-label="模型"
								disabled={!gui.snapshot || gui.snapshot.busy}
								onClick={() => act({ action: "view", view: "model" })}
							>
								<SlidersHorizontal />
								{!compact && <span>模型</span>}
							</Button>
						</TooltipTrigger>
						{compact && <TooltipContent side="right">模型</TooltipContent>}
					</Tooltip>
				</nav>
				{!compact && <SessionHistory gui={gui} close={close} />}
			</div>
			<div className="sidebar-footer">
				<IconButton label="设置" disabled={!gui.snapshot || gui.snapshot.busy} onClick={() => act({ action: "view", view: "settings" })}>
					<Settings2 />
				</IconButton>
				<IconButton label="认证" disabled={!gui.snapshot || gui.snapshot.busy} onClick={() => act({ action: "view", view: "auth" })}>
					<KeyRound />
				</IconButton>
				<IconButton label="套餐用量" disabled={!gui.snapshot || gui.snapshot.busy} onClick={() => act({ action: "view", view: "usage" })}>
					<Activity />
				</IconButton>
				<IconButton label="重载资源" disabled={!gui.snapshot || gui.snapshot.busy || gui.running} onClick={() => act({ action: "reload" })}>
					<RefreshCw />
				</IconButton>
			</div>
		</>
	);
	return (
		<>
			<aside className="sidebar" aria-label="侧栏" data-collapsed={collapsed}>
				{content(collapsed, false)}
			</aside>
			<SheetContent side="left" className="mobile-sidebar" showCloseButton={false} aria-describedby={undefined}>
				<SheetTitle className="sr-only">工作空间导航</SheetTitle>
				{content(false, true)}
			</SheetContent>
		</>
	);
}
