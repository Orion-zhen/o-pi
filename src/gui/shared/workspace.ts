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
