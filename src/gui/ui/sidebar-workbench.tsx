import { useRef, useState, type CSSProperties } from "react";
import { ChevronRight, FileDiff, FoldVertical, GitBranch, Plus, RefreshCw, Search } from "lucide-react";
import type { GuiView } from "./use-gui.ts";
import { SessionHistory } from "./session-history.tsx";
import { WorkspacePicker } from "./workspace-picker.tsx";
import { WorkspaceChanges, WorkspaceTree } from "./workspace-tree.tsx";
import { IconButton } from "./components/icon-button";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import "./workbench.css";

export function SidebarWorkbench({ gui, close }: { gui: GuiView; close: () => void }) {
	const [search, setSearch] = useState("");
	const [filesOpen, setFilesOpen] = useState(true);
	const [ratio, setRatio] = useState(55);
	const [pane, setPane] = useState("sessions");
	const sections = useRef<HTMLDivElement>(null);
	const drag = useRef<{ y: number; ratio: number } | null>(null);
	const { workbench } = gui;
	const { onlyChanges, setOnlyChanges } = workbench;
	const git = workbench.git.state === "ready" ? workbench.git.value : null;
	const referenceFile = (path: string) => { close(); gui.referenceFile(path); };
	const blocked = !gui.canChangeSession;
	const resize = (value: number) => setRatio(Math.max(25, Math.min(75, value)));
	const proportions: CSSProperties & { "--session-share": number; "--file-share": number } = { "--session-share": ratio, "--file-share": 100 - ratio };
	return <div className="sidebar-workbench">
		<div className="workbench-workspace"><WorkspacePicker gui={gui} close={close} /></div>
		<div className="workbench-pane-tabs" aria-label="导航区域">
			<Button variant="ghost" aria-pressed={pane === "sessions"} onClick={() => setPane("sessions")}>会话</Button>
			<Button variant="ghost" aria-pressed={pane === "files"} onClick={() => { setPane("files"); setFilesOpen(true); }}>文件</Button>
		</div>
		<div className="workbench-sections" ref={sections} data-files-open={filesOpen} data-pane={pane} style={proportions}>
			<div className="workbench-sessions">
				<div className="workbench-session-controls">
					<div className="session-search-controls">
						<div className="session-search"><Search aria-hidden="true" /><Input aria-label="搜索会话" placeholder="搜索会话…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
						<Button variant="outline" aria-label="新建会话" disabled={blocked} onClick={() => { void gui.send({ action: "new" }); close(); }}><Plus />新建</Button>
					</div>
				</div>
				<SessionHistory gui={gui} close={close} search={search} />
			</div>
			{filesOpen && <div className="workbench-separator" role="separator" aria-label="调整会话与文件区域" aria-orientation="horizontal"
				tabIndex={0} aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(ratio)}
				onPointerDown={(event) => {
					drag.current = { y: event.clientY, ratio };
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={(event) => {
					if (drag.current && sections.current) resize(drag.current.ratio + (event.clientY - drag.current.y) / sections.current.clientHeight * 100);
				}}
				onPointerUp={(event) => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
				onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
				onKeyDown={(event) => {
					if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
						event.preventDefault();
						resize(event.key === "Home" ? 25 : event.key === "End" ? 75 : ratio + (event.key === "ArrowUp" ? -5 : 5));
					}
				}} />}
			<section className="workspace-files" aria-label="项目文件" data-open={filesOpen}>
				<div className="workspace-files-heading">
					<Button variant="ghost" className="files-toggle" aria-label={filesOpen ? "收起文件区" : "展开文件区"} aria-expanded={filesOpen}
						onClick={() => { setFilesOpen(!filesOpen); if (!filesOpen) setPane("files"); }}>
						<ChevronRight data-open={filesOpen} /><span>文件</span>
					</Button>
					<span className="git-branch" title={git?.branch ?? (workbench.git.state === "error" ? workbench.git.message : undefined)}>
						{git && <GitBranch aria-hidden="true" />}
						<span>{git ? git.branch : workbench.git.state === "loading" ? "Git…" : workbench.git.state === "error" ? "Git 读取失败" : "无 Git"}</span>
					</span>
					<IconButton label="显示文件变更" size="icon-sm" className="file-changes-toggle" aria-pressed={onlyChanges} disabled={!git}
						onClick={() => { setOnlyChanges(!onlyChanges); setFilesOpen(true); setPane("files"); }}><FileDiff /><span>{git?.changes.length ?? 0}</span></IconButton>
					<IconButton label="刷新文件" size="icon-sm" disabled={!gui.snapshot || !gui.connected} onClick={workbench.refresh}><RefreshCw /></IconButton>
					<IconButton label="折叠全部目录" size="icon-sm" disabled={onlyChanges || !workbench.expanded.size} onClick={workbench.collapseAll}><FoldVertical /></IconButton>
				</div>
				{filesOpen && <div className="workspace-files-content">
					{workbench.git.state === "error" && <p className="file-hint" role="alert">Git: {workbench.git.message}</p>}
					<div className="workspace-files-scroll">
						{!gui.snapshot ? <p className="file-hint">请先选择工作区</p> : onlyChanges && git
							? <WorkspaceChanges git={git} selected={workbench.preview?.path} referenceFile={referenceFile} openFile={(path) => { gui.openFile(path); close(); }} />
							: <WorkspaceTree workbench={workbench} referenceFile={referenceFile} openFile={(path) => { gui.openFile(path); close(); }} />}
					</div>
				</div>}
			</section>
		</div>
	</div>;
}
