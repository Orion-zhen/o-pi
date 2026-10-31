import { memo, useLayoutEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { ChevronRight } from "lucide-react";
import { Check, Copy } from "lucide";
import { MorphIcon } from "morphicons/react";
import { motion } from "motion/react";
import { ReferenceFileButton } from "./reference-file-button.tsx";
import { startupRow, useStartupLists } from "@/app/welcome/startup-entrance.tsx";
import { FileIcon } from "@/ui/file-icon.tsx";
import { gitStatusLabels, indexWorkspaceGit } from "./git.ts";
import { type WorkspaceGit } from "../../../shared/workspace.ts";
import type { WorkbenchView } from "./use-workbench.ts";
import { workspaceTreeRows } from "./workspace-tree-rows.ts";
import { useVirtualRows } from "@/ui/use-virtual-rows.ts";
import { Hint } from "@/ui/tooltip.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { useClipboard } from "@/ui/use-clipboard.ts";
import { nativeFileEvents } from "./native-file.ts";

function FileRowActions({ path, referenceFile }: { path: string; referenceFile: (path: string) => boolean }) {
	const clipboard = useClipboard();
	return <div className="row-actions">
		<IconButton label={`${clipboard.status === "error" ? "复制失败，重试" : clipboard.status === "copied" ? "已复制路径" : "复制路径"} ${path}`} className="row-action-button"
			tooltip={clipboard.status === "error" ? "重试复制" : clipboard.status === "copied" ? "已复制" : "复制路径"}
			onClick={(event) => {
				if (event.detail > 0) event.currentTarget.blur();
				void clipboard.copy(path);
			}}><MorphIcon icon={clipboard.status === "copied" ? Check : Copy} spring="smooth" size="1em" /></IconButton>
		<ReferenceFileButton path={path} referenceFile={referenceFile} direction={1} />
	</div>;
}

type FileActions = { cwd: string; setError: (message: string) => void; openFile: (path: string) => void; referenceFile: (path: string) => boolean };
export const WorkspaceChanges = memo(function WorkspaceChanges({ cwd, setError, git, selected, openFile, referenceFile }: FileActions & {
	git: WorkspaceGit; selected: string | undefined;
}) {
	const changes = useMemo(() => [...git.changes].sort((a, b) => a.path.localeCompare(b.path)), [git]);
	const lists = useStartupLists();
	const list = useVirtualRows<HTMLUListElement>(changes.length, (index) => changes[index]?.path ?? "", 32);
	return <ul ref={list.root} style={list.style} className="workspace-changes" aria-label="工作区变更">
		{!changes.length && <li className="file-hint">没有文件变更</li>}
		{list.rows.map((row) => {
			const change = changes[row.index];
			if (!change) return null;
			return <li key={row.key} data-index={row.index} ref={list.windowed ? list.virtualizer.measureElement : undefined} style={list.rowStyle(row.start)}>
			<motion.div className="file-entry-row overlay-list-row" {...startupRow(lists, row.index, changes.length)}>
			<Hint content={`${change.originalPath ? `${change.originalPath} -> ` : ""}${change.path}`}><button type="button" className="file-row file-change-row" data-status={change.status} aria-label={change.path}
				aria-pressed={selected === change.path} aria-description={gitStatusLabels[change.status]}
				{...(change.status !== "D" ? nativeFileEvents(cwd, change.path, true, setError) : {})}
				onClick={() => openFile(change.path)}>
				<span className="git-status" data-status={change.status} aria-hidden="true">{change.status}</span>
				<FileIcon name={change.path} kind="file" />
				<span className="file-name">{change.path}</span>
			</button></Hint>
			{change.status !== "D" && <FileRowActions path={change.path} referenceFile={referenceFile} />}
			</motion.div>
		</li>;
		})}
	</ul>;
});

export const WorkspaceTree = memo(function WorkspaceTree({ cwd, setError, workbench, openFile, referenceFile }: FileActions & { workbench: WorkbenchView }) {
	const git = workbench.git.state === "ready" ? workbench.git.value : null;
	const index = useMemo(() => indexWorkspaceGit(git), [git]);
	const rows = useMemo(() => workspaceTreeRows(workbench.directories, workbench.expanded, index), [workbench.directories, workbench.expanded, index]);
	const lists = useStartupLists();
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
				return <motion.div className="file-entry-row overlay-list-row" {...startupRow(lists, item.index, rows.length)}>
					<Hint content={entry.path}><button type="button" role="treeitem" aria-label={entry.path} aria-level={depth + 1} aria-posinset={row.position} aria-setsize={row.siblings}
						aria-expanded={entry.kind === "directory" ? open : undefined} aria-selected={workbench.preview?.path === entry.path}
						tabIndex={-1} aria-description={state}
						className="file-row" data-ignored={ignored} data-status={change?.status} style={{ paddingInlineStart: `${0.25 + depth}em` }}
						{...(!entry.virtual && change?.status !== "D" ? nativeFileEvents(cwd, entry.path, entry.kind === "file", setError) : {})}
						onClick={() => entry.kind === "directory" ? workbench.toggleDirectory(entry.path, entry.virtual) : openFile(entry.path)}>
						<ChevronRight className="file-chevron" data-directory={entry.kind === "directory"} data-open={open} aria-hidden="true" />
						<FileIcon name={entry.name} kind={entry.kind} open={open} /><span className="file-name">{entry.name}</span>
						{state && <span className="sr-only">{state}</span>}
						{change && <span className="git-status" data-status={change.status} aria-hidden="true">{change.status}</span>}
						{!change && descendants > 0 && <span className="git-descendants" aria-hidden="true">{descendants}</span>}
					</button></Hint>
					{!entry.virtual && change?.status !== "D" && <FileRowActions path={entry.path} referenceFile={referenceFile} />}
				</motion.div>;
			};
			return <li key={item.key} role="none" data-index={item.index} ref={list.windowed ? list.virtualizer.measureElement : undefined} style={list.rowStyle(item.start)}>{content()}</li>;
		})}
	</ul>;
});
