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
export interface FilePreview {
	path: string;
	content:
		| { kind: "text"; text: string }
		| { kind: "image"; data: string; mime: string }
		| { kind: "unavailable"; reason: string }
		| { kind: "deleted" };
	diffs: { title: string; text: string }[];
}
export const gitStatusLabels: Record<GitStatus, string> = {
	M: "已修改", A: "已添加", D: "已删除", R: "已重命名", C: "已复制", U: "冲突", "?": "未跟踪",
};

export function fileGitState(path: string, git: WorkspaceGit | null | undefined) {
	const change = git?.changes.find((change) => change.path === path);
	const descendants = git?.changes.filter((change) => change.path.startsWith(`${path}/`)).length ?? 0;
	const ignored = git?.ignored.some((entry) => path === entry || path.startsWith(`${entry}/`)) ?? false;
	return { change, descendants, ignored };
}
