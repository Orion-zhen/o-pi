export interface WorkspaceEntry {
	path: string;
	name: string;
	kind: "directory" | "file" | "symlink";
}
export type GitStatus = "M" | "A" | "D" | "R" | "C" | "U" | "?";
export interface GitChange {
	path: string;
	status: GitStatus;
	originalPath?: string;
}
export interface WorkspaceGit {
	branch: string;
	changes: GitChange[];
	ignored: string[];
}
export type FileMedia = { mime: string; size: number; version: string } & ({ kind: "image" } | { kind: "pdf" });
export interface WorkspacePreview {
	path: string;
	content:
		| { kind: "text"; text: string }
		| FileMedia
		| { kind: "unavailable"; reason: string }
		| { kind: "deleted" };
	diffs: { title: string; text: string }[];
}
export interface FilePreview extends Omit<WorkspacePreview, "content"> {
	content: Exclude<WorkspacePreview["content"], FileMedia> | (FileMedia & { url: string });
}
export const gitStatusLabels: Record<GitStatus, string> = {
	M: "已修改", A: "已添加", D: "已删除", R: "已重命名", C: "已复制", U: "冲突", "?": "未跟踪",
};

export function indexWorkspaceGit(git: WorkspaceGit | null | undefined) {
	const changes = new Map<string, GitChange>();
	const descendants = new Map<string, number>();
	const children = new Map<string, Map<string, WorkspaceEntry>>();
	for (const change of git?.changes ?? []) {
		changes.set(change.path, change);
		const parts = change.path.split("/");
		let parent = "";
		for (const [index, name] of parts.entries()) {
			const path = parent ? `${parent}/${name}` : name;
			const directory = children.get(parent) ?? new Map<string, WorkspaceEntry>();
			directory.set(path, { path, name, kind: index < parts.length - 1 ? "directory" : "file" });
			children.set(parent, directory);
			if (parent) descendants.set(parent, (descendants.get(parent) ?? 0) + 1);
			parent = path;
		}
	}
	return { changes, descendants, children, ignored: new Set(git?.ignored) };
}
export type WorkspaceGitIndex = ReturnType<typeof indexWorkspaceGit>;

export function fileGitState(path: string, git: WorkspaceGitIndex) {
	let ancestor = path;
	let ignored = git.ignored.has(ancestor);
	while (!ignored && ancestor.includes("/")) {
		ancestor = ancestor.slice(0, ancestor.lastIndexOf("/"));
		ignored = git.ignored.has(ancestor);
	}
	return { change: git.changes.get(path), descendants: git.descendants.get(path) ?? 0, ignored };
}
