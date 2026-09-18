import { fileGitState, type WorkspaceEntry, type WorkspaceGitIndex } from "../workbench.ts";
import type { WorkbenchView } from "./use-workbench.ts";

export interface TreeEntry extends WorkspaceEntry { virtual?: boolean }
export type TreeRow = { key: string; depth: number } & (
	| { kind: "hint"; message: string; error: boolean }
	| { kind: "entry"; entry: TreeEntry; position: number; siblings: number; state: ReturnType<typeof fileGitState> }
);

export function workspaceTreeRows(directories: WorkbenchView["directories"], expanded: Set<string>, git: WorkspaceGitIndex): TreeRow[] {
	const rows: TreeRow[] = [];
	const visit = (path: string, depth: number, virtual = false) => {
		const remote = directories[path];
		const hint = (message: string, error = false) => rows.push({ key: `hint:${path}`, kind: "hint", depth, message, error });
		if (!virtual && (!remote || remote.state === "loading")) { hint("正在读取…"); return; }
		if (!virtual && remote?.state === "error") { hint(remote.message, true); return; }
		const entries = new Map<string, TreeEntry>((remote?.state === "ready" ? remote.value : []).map((entry) => [entry.path, entry]));
		for (const [child, entry] of git.children.get(path) ?? []) if (!entries.has(child)) entries.set(child, { ...entry, virtual: true });
		const sorted = [...entries.values()].sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
		if (!sorted.length) { hint("空目录"); return; }
		for (const [index, entry] of sorted.entries()) {
			rows.push({ key: entry.path, kind: "entry", entry, depth, position: index + 1, siblings: sorted.length, state: fileGitState(entry.path, git) });
			if (entry.kind === "directory" && expanded.has(entry.path)) visit(entry.path, depth + 1, entry.virtual);
		}
	};
	visit("", 0);
	return rows;
}
