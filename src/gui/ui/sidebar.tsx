import {
	Activity,
	BookOpen,
	ChartNoAxesCombined,
	ChevronDown,
	Download,
	Ellipsis,
	FileJson,
	FolderOpen,
	GitBranch,
	History,
	KeyRound,
	Layers,
	PanelLeftClose,
	PanelLeftOpen,
	Plus,
	RefreshCw,
	Settings2,
	SlidersHorizontal,
	Terminal,
	Upload,
	Wrench,
} from "lucide-react";
import type { GuiView } from "./use-gui.ts";
import { SessionHistory } from "./session-history.tsx";
import { IconButton } from "./components/icon-button";
import { Button } from "./components/ui/button";
import { WorkspacePicker } from "./workspace-picker.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { SheetClose, SheetContent, SheetTitle } from "./components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";

const navigation = [
	{ command: "resume", label: "会话", icon: History },
	{ command: "tree", label: "会话树", icon: GitBranch },
	{ command: "tools", label: "工具", icon: Wrench },
	{ command: "model", label: "模型", icon: SlidersHorizontal },
	{ command: "skill", label: "技能", icon: Layers },
];

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
	const command = (text: string) => {
		close();
		gui.command(text);
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
					{navigation.map(({ command: name, label, icon: Icon }) => (
						<Tooltip key={name}>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									aria-label={label}
									disabled={!gui.snapshot || gui.snapshot.busy}
									onClick={() => command(`/${name}`)}
								>
									<Icon />
									{!compact && <span>{label}</span>}
								</Button>
							</TooltipTrigger>
							{compact && <TooltipContent side="right">{label}</TooltipContent>}
						</Tooltip>
					))}
				</nav>
				{!compact && <SessionHistory gui={gui} close={close} />}
			</div>
			<div className="sidebar-footer">
				<IconButton label="设置" disabled={!gui.snapshot || gui.snapshot.busy} onClick={() => command("/settings")}>
					<Settings2 />
				</IconButton>
				<IconButton label="认证" disabled={!gui.snapshot || gui.snapshot.busy} onClick={() => command("/login")}>
					<KeyRound />
				</IconButton>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<IconButton label="更多操作" disabled={!gui.snapshot || gui.snapshot.busy}>
							<Ellipsis />
						</IconButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent side={compact ? "right" : "top"} align="start">
						<DropdownMenuLabel>工作空间</DropdownMenuLabel>
						<DropdownMenuItem onSelect={() => command("/stats")}>
							<ChartNoAxesCombined />
							会话统计
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => command("/usage")}>
							<Activity />
							套餐用量
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => command("/telemetry")}>
							<Activity />
							遥测
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => command("/system")}>
							<Terminal />
							系统提示词
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => command("/help")}>
							<BookOpen />
							命令帮助
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => command("/import")}>
							<Upload />
							导入会话
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => command("/export jsonl")}>
							<FileJson />
							导出 JSONL
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => command("/export")}>
							<Download />
							导出 HTML
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => command("/reload")}>
							<RefreshCw />
							重载资源
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
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
