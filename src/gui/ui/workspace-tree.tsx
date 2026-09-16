import type { KeyboardEvent, ReactNode } from "react";
import { AtSign, ChevronRight, FileCode2, FileText, FolderClosed, FolderOpen, Image, Link } from "lucide-react";
import { fileGitState, gitStatusLabels, type WorkspaceEntry, type WorkspaceGit } from "../workbench.ts";
import type { WorkbenchView } from "./use-workbench.ts";
import { IconButton } from "./components/icon-button";

interface TreeEntry extends WorkspaceEntry { virtual?: boolean }
function directoryEntries(path: string, entries: WorkspaceEntry[], git: WorkspaceGit | null): TreeEntry[] {
	const result = new Map<string, TreeEntry>(entries.map((entry) => [entry.path, entry]));
	const prefix = path ? `${path}/` : "";
	for (const change of git?.changes ?? []) {
		if (!change.path.startsWith(prefix)) continue;
		const parts = change.path.slice(prefix.length).split("/");
		const name = parts[0];
		if (!name) continue;
		const child = `${prefix}${name}`;
		if (!result.has(child)) result.set(child, { path: child, name, kind: parts.length > 1 ? "directory" : "file", virtual: true });
	}
	return [...result.values()].sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
}
function FileIcon({ entry, open }: { entry: WorkspaceEntry; open: boolean }) {
	if (entry.kind === "directory") return open ? <FolderOpen /> : <FolderClosed />;
	if (entry.kind === "symlink") return <Link />;
	if (/\.(png|jpe?g|gif|webp|svg)$/i.test(entry.name)) return <Image />;
	return /\.(tsx?|jsx?|json[c]?|css|html|py|rs|go|sh|c|cpp)$/i.test(entry.name) ? <FileCode2 /> : <FileText />;
}

function FileReference({ path, referenceFile }: { path: string; referenceFile: (path: string) => void }) {
	return <div className="row-actions"><IconButton label={`引用路径 ${path}`} className="row-action-button file-reference-button"
		onClick={() => referenceFile(path)}><AtSign /></IconButton></div>;
}

export function WorkspaceChanges({ git, selected, openFile, referenceFile }: {
	git: WorkspaceGit; selected: string | undefined; openFile: (path: string) => void; referenceFile: (path: string) => void;
}) {
	return <ul className="workspace-changes" aria-label="工作区变更">
		{!git.changes.length && <li className="file-hint">没有文件变更</li>}
		{[...git.changes].sort((a, b) => a.path.localeCompare(b.path)).map((change) => <li key={change.path}>
			<div className="file-entry-row overlay-list-row">
			<button type="button" className="file-row file-change-row" data-status={change.status} aria-label={change.path}
				aria-pressed={selected === change.path} aria-description={gitStatusLabels[change.status]}
				title={`${change.originalPath ? `${change.originalPath} -> ` : ""}${change.path} (${gitStatusLabels[change.status]})`}
				onClick={() => openFile(change.path)}>
				<span className="git-status" data-status={change.status} aria-hidden="true">{change.status}</span>
				<FileIcon entry={{ path: change.path, name: change.path, kind: "file" }} open={false} />
				<span className="file-name">{change.path}</span>
			</button>
			{change.status !== "D" && <FileReference path={change.path} referenceFile={referenceFile} />}
			</div>
		</li>)}
	</ul>;
}

export function WorkspaceTree({ workbench, openFile, referenceFile }: {
	workbench: WorkbenchView; openFile: (path: string) => void; referenceFile: (path: string) => void;
}) {
	const git = workbench.git.state === "ready" ? workbench.git.value : null;
	const keyDown = (event: KeyboardEvent<HTMLUListElement>) => {
		const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="treeitem"]')];
		const current = buttons.findIndex((button) => button === event.target);
		const button = buttons[current];
		if (!button) return;
		let target: HTMLButtonElement | undefined;
		if (event.key === "ArrowDown") target = buttons[Math.min(current + 1, buttons.length - 1)];
		else if (event.key === "ArrowUp") target = buttons[Math.max(current - 1, 0)];
		else if (event.key === "Home") target = buttons[0];
		else if (event.key === "End") target = buttons.at(-1);
		else if (event.key === "ArrowRight") {
			if (button.getAttribute("aria-expanded") === "false") button.click();
			else if (button.getAttribute("aria-expanded") === "true") target = buttons[current + 1];
		} else if (event.key === "ArrowLeft") {
			if (button.getAttribute("aria-expanded") === "true") button.click();
			else target = buttons.slice(0, current).findLast((parent) => Number(parent.getAttribute("aria-level")) < Number(button.getAttribute("aria-level")));
		} else return;
		event.preventDefault();
		target?.focus();
	};
	const renderDirectory = (path: string, depth: number, virtual = false): ReactNode => {
		const remote = workbench.directories[path];
		if (!virtual && (!remote || remote.state === "loading")) return <li role="none" className="file-hint">正在读取…</li>;
		if (!virtual && remote?.state === "error") return <li role="none" className="file-hint"><span role="alert">{remote.message}</span></li>;
		const entries = directoryEntries(path, remote?.state === "ready" ? remote.value : [], git);
		if (!entries.length) return <li role="none" className="file-hint">空目录</li>;
		return entries.map((entry) => {
			const { change, descendants, ignored } = fileGitState(entry.path, git);
			const open = workbench.expanded.has(entry.path);
			const state = change ? gitStatusLabels[change.status] : descendants ? `${descendants} 个文件变更` : ignored ? "Git 忽略项" : "";
			return <li key={entry.path} role="none">
				<div className="file-entry-row overlay-list-row">
				<button type="button" role="treeitem" aria-label={entry.path} aria-level={depth + 1}
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
				{!entry.virtual && change?.status !== "D" && <FileReference path={entry.path} referenceFile={referenceFile} />}
				</div>
				{entry.kind === "directory" && open && <ul role="group">{renderDirectory(entry.path, depth + 1, entry.virtual)}</ul>}
			</li>;
		});
	};
	return <ul className="workspace-tree" role="tree" aria-label="工作区文件" onKeyDown={keyDown}
		onFocus={(event) => {
			if (event.target === event.currentTarget) event.currentTarget.querySelector<HTMLButtonElement>('[role="treeitem"]')?.focus();
		}} tabIndex={0}>{renderDirectory("", 0)}</ul>;
}
