import { useRef, useState, type CSSProperties } from "react";
import { ChevronRight, FileDiff, FoldVertical, GitBranch, Plus, RefreshCw, Search } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { Fade } from "./components/animated";
import type { GuiView } from "./use-gui.ts";
import { SessionHistory } from "./session-history.tsx";
import { WorkspacePicker } from "./workspace-picker.tsx";
import { WorkspaceChanges, WorkspaceTree } from "./workspace-tree.tsx";
import { IconButton } from "./components/icon-button";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { ResizeHandle } from "./components/resize-handle";
import "./workbench.css";

export function SidebarWorkbench({ gui, close }: { gui: GuiView; close: () => void }) {
	const [search, setSearch] = useState("");
	const [filesOpen, setFilesOpen] = useState(true);
	const ratio = gui.layout.values.files ?? 55;
	const [pane, setPane] = useState("sessions");
	const sections = useRef<HTMLDivElement>(null);
	const { workbench } = gui;
	const { onlyChanges, setOnlyChanges } = workbench;
	const git = workbench.git.state === "ready" ? workbench.git.value : null;
	const referenceFile = (path: string) => { close(); gui.referenceFile(path); };
	const blocked = !gui.canChangeSession;
	const proportions: CSSProperties & { "--session-share": string; "--file-share": string } = { "--session-share": `${ratio}fr`, "--file-share": `${100 - ratio}fr` };
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
			<ResizeHandle className="workbench-separator" label="调整会话与文件区域" axis="y" value={gui.layout.values.files}
				change={(value, persist) => gui.layout.set("files", value, persist)} measure={() => {
					const sessions = sections.current?.querySelector<HTMLElement>(".workbench-sessions");
					const files = sections.current?.querySelector<HTMLElement>(".workspace-files-content");
					const height = (sessions?.clientHeight ?? 0) + (files?.clientHeight ?? 0);
					const min = height > 0 ? Math.min(40, 8000 / height) : 0;
					return { value: ratio, min, max: 100 - min, scale: height > 0 ? 100 / height : 0 };
				}} />
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
				<div className="workspace-files-content" inert={!filesOpen} aria-hidden={!filesOpen}>
					{workbench.git.state === "error" && <p className="file-hint" role="alert">Git: {workbench.git.message}</p>}
					<div className="workspace-files-scroll">
						<AnimatePresence initial={false} mode="wait"><Fade key={onlyChanges ? "changes" : "tree"}>
						{!gui.snapshot ? <p className="file-hint">请先选择工作区</p> : onlyChanges && git
							? <WorkspaceChanges git={git} selected={workbench.preview?.path} referenceFile={referenceFile} openFile={(path) => { gui.openFile(path); close(); }} />
							: <WorkspaceTree workbench={workbench} referenceFile={referenceFile} openFile={(path) => { gui.openFile(path); close(); }} />}
						</Fade></AnimatePresence>
					</div>
				</div>
			</section>
		</div>
	</div>;
}
