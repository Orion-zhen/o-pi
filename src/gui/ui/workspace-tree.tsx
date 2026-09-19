import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AtSign, Check, ChevronRight, Copy, Link } from "lucide-react";
import { DefaultFolderIcon, DefaultFolderOpenedIcon, FileIcon as SymbolsFileIcon } from "@react-symbols/icons/utils";
import { gitStatusLabels, indexWorkspaceGit, type WorkspaceEntry, type WorkspaceGit } from "../workbench.ts";
import type { WorkbenchView } from "./use-workbench.ts";
import { workspaceTreeRows } from "./workspace-tree-rows.ts";
import { useVirtualRows } from "./use-virtual-rows.ts";
import { IconButton } from "./components/icon-button";

function FileIcon({ entry, open }: { entry: WorkspaceEntry; open: boolean }) {
	if (entry.kind === "directory") {
		const Icon = open ? DefaultFolderOpenedIcon : DefaultFolderIcon;
		return <Icon className="file-type-icon" aria-hidden="true" focusable="false" />;
	}
	if (entry.kind === "symlink") return <Link />;
	const name = entry.name.slice(entry.name.lastIndexOf("/") + 1);
	return <SymbolsFileIcon fileName={name} autoAssign className="file-type-icon" aria-hidden="true" focusable="false" />;
}

function FileRowActions({ path, referenceFile }: { path: string; referenceFile: (path: string) => void }) {
	const [copyState, setCopyState] = useState<{ status: "idle" | "copied" | "error" }>({ status: "idle" });
	useEffect(() => {
		if (copyState.status !== "copied") return;
		const timer = setTimeout(() => setCopyState({ status: "idle" }), 1500);
		return () => clearTimeout(timer);
	}, [copyState]);
	return <div className="row-actions">
		<IconButton label={`${copyState.status === "error" ? "复制失败，重试" : copyState.status === "copied" ? "已复制路径" : "复制路径"} ${path}`} className="row-action-button"
			onClick={async (event) => {
				if (event.detail > 0) event.currentTarget.blur();
				try {
					await navigator.clipboard.writeText(path);
					setCopyState({ status: "copied" });
				} catch {
					setCopyState({ status: "error" });
				}
			}}>{copyState.status === "copied" ? <Check /> : <Copy />}</IconButton>
		<IconButton label={`引用路径 ${path}`} className="row-action-button"
			onClick={() => referenceFile(path)}><AtSign /></IconButton>
	</div>;
}

type FileActions = { openFile: (path: string) => void; referenceFile: (path: string) => void };
export const WorkspaceChanges = memo(function WorkspaceChanges({ git, selected, openFile, referenceFile }: FileActions & {
	git: WorkspaceGit; selected: string | undefined;
}) {
	const changes = useMemo(() => [...git.changes].sort((a, b) => a.path.localeCompare(b.path)), [git]);
	const list = useVirtualRows<HTMLUListElement>(changes.length, (index) => changes[index]?.path ?? "", 32);
	return <ul ref={list.root} style={list.style} className="workspace-changes" aria-label="工作区变更">
		{!changes.length && <li className="file-hint">没有文件变更</li>}
		{list.rows.map((row) => {
			const change = changes[row.index];
			if (!change) return null;
			return <li key={row.key} data-index={row.index} ref={list.windowed ? list.virtualizer.measureElement : undefined} style={list.rowStyle(row.start)}>
			<div className="file-entry-row overlay-list-row">
			<button type="button" className="file-row file-change-row" data-status={change.status} aria-label={change.path}
				aria-pressed={selected === change.path} aria-description={gitStatusLabels[change.status]}
				title={`${change.originalPath ? `${change.originalPath} -> ` : ""}${change.path} (${gitStatusLabels[change.status]})`}
				onClick={() => openFile(change.path)}>
				<span className="git-status" data-status={change.status} aria-hidden="true">{change.status}</span>
				<FileIcon entry={{ path: change.path, name: change.path, kind: "file" }} open={false} />
				<span className="file-name">{change.path}</span>
			</button>
			{change.status !== "D" && <FileRowActions path={change.path} referenceFile={referenceFile} />}
			</div>
		</li>;
		})}
	</ul>;
});

export const WorkspaceTree = memo(function WorkspaceTree({ workbench, openFile, referenceFile }: FileActions & { workbench: WorkbenchView }) {
	const git = workbench.git.state === "ready" ? workbench.git.value : null;
	const index = useMemo(() => indexWorkspaceGit(git), [git]);
	const rows = useMemo(() => workspaceTreeRows(workbench.directories, workbench.expanded, index), [workbench.directories, workbench.expanded, index]);
	const list = useVirtualRows<HTMLUListElement>(rows.length, (index) => rows[index]?.key ?? "", 32);
	const pendingFocus = useRef<string | undefined>(undefined);
	useLayoutEffect(() => {
		if (pendingFocus.current === undefined) return;
		const index = rows.findIndex((row) => row.key === pendingFocus.current);
		const button = list.root.current?.querySelector<HTMLButtonElement>(`[data-index="${index}"] [role="treeitem"]`);
		if (button) { button.focus({ preventScroll: true }); pendingFocus.current = undefined; }
	});
	const focus = (index: number) => {
		const row = rows[index];
		if (!row) return;
		const button = list.root.current?.querySelector<HTMLButtonElement>(`[data-index="${index}"] [role="treeitem"]`);
		if (button) { button.focus(); return; }
		pendingFocus.current = row.key;
		list.virtualizer.scrollToIndex(index, { align: "auto" });
	};
	const keyDown = (event: KeyboardEvent<HTMLUListElement>) => {
		if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "treeitem") return;
		const current = Number(event.target.closest<HTMLElement>("[data-index]")?.dataset.index);
		const row = rows[current];
		if (!row || row.kind !== "entry") return;
		let target = current;
		if (event.key === "ArrowDown") target = rows.findIndex((row, index) => index > current && row.kind === "entry");
		else if (event.key === "ArrowUp") target = rows.findLastIndex((row, index) => index < current && row.kind === "entry");
		else if (event.key === "Home") target = rows.findIndex((row) => row.kind === "entry");
		else if (event.key === "End") target = rows.findLastIndex((row) => row.kind === "entry");
		else if (event.key === "ArrowRight") {
			if (row.entry.kind === "directory") {
				if (!workbench.expanded.has(row.entry.path)) workbench.toggleDirectory(row.entry.path, row.entry.virtual);
				else target = rows.findIndex((row, index) => index > current && row.kind === "entry");
			}
		} else if (event.key === "ArrowLeft") {
			if (row.entry.kind === "directory" && workbench.expanded.has(row.entry.path)) workbench.toggleDirectory(row.entry.path, row.entry.virtual);
			else target = rows.findLastIndex((item, index) => index < current && item.kind === "entry" && item.depth < row.depth);
		} else return;
		event.preventDefault();
		if (target >= 0 && target !== current) focus(target);
	};
	return <ul ref={list.root} style={list.style} className="workspace-tree" role="tree" aria-label="工作区文件" onKeyDown={keyDown}
		onFocus={(event) => { if (event.target === event.currentTarget) focus(rows.findIndex((row) => row.kind === "entry")); }} tabIndex={0}>
		{list.rows.map((item) => {
			const row = rows[item.index];
			if (!row) return null;
			const content = () => {
				if (row.kind === "hint") return <div className="file-hint" role={row.error ? "alert" : undefined}>{row.message}</div>;
				const { entry, depth, state: { change, descendants, ignored } } = row;
				const open = workbench.expanded.has(entry.path);
				const state = change ? gitStatusLabels[change.status] : descendants ? `${descendants} 个文件变更` : ignored ? "Git 忽略项" : "";
				return <div className="file-entry-row overlay-list-row">
					<button type="button" role="treeitem" aria-label={entry.path} aria-level={depth + 1} aria-posinset={row.position} aria-setsize={row.siblings}
						aria-expanded={entry.kind === "directory" ? open : undefined} aria-selected={workbench.preview?.path === entry.path}
						tabIndex={-1} aria-description={state} title={`${entry.path}${state ? ` (${state})` : ""}`}
						className="file-row" data-ignored={ignored} data-status={change?.status} style={{ paddingInlineStart: `${0.75 + depth}em` }}
						onClick={() => entry.kind === "directory" ? workbench.toggleDirectory(entry.path, entry.virtual) : openFile(entry.path)}>
						<ChevronRight className="file-chevron" data-directory={entry.kind === "directory"} data-open={open} />
						<FileIcon entry={entry} open={open} /><span className="file-name">{entry.name}</span>
						{state && <span className="sr-only">{state}</span>}
						{change && <span className="git-status" data-status={change.status} aria-hidden="true">{change.status}</span>}
						{!change && descendants > 0 && <span className="git-descendants" aria-hidden="true">{descendants}</span>}
					</button>
					{!entry.virtual && change?.status !== "D" && <FileRowActions path={entry.path} referenceFile={referenceFile} />}
				</div>;
			};
			return <li key={item.key} role="none" data-index={item.index} ref={list.windowed ? list.virtualizer.measureElement : undefined} style={list.rowStyle(item.start)}>{content()}</li>;
		})}
	</ul>;
});
