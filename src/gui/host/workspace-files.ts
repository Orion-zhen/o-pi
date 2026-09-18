import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import type { FilePreview, WorkspaceEntry, WorkspaceGit } from "../workbench.ts";
import { gitOutput, readWorkspaceGit } from "./workspace-git.ts";

const MAX_PREVIEW = 512 * 1024;
const inside = (root: string, target: string) => {
	const relative = path.relative(root, target);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		throw new Error("文件路径超出当前工作区。");
};

async function workspacePath(cwd: string, name: string, missing = false): Promise<string> {
	if (path.isAbsolute(name)) throw new Error("文件路径必须相对当前工作区。");
	const root = await realpath(cwd);
	const target = path.resolve(root, name);
	inside(root, target);
	let existing = target;
	for (;;) {
		try {
			const resolved = await realpath(existing);
			inside(root, resolved);
			return path.resolve(resolved, path.relative(existing, target));
		} catch (error) {
			if (!missing || !(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			existing = path.dirname(existing);
		}
	}
}

export async function listWorkspaceFiles(cwd: string, name: string): Promise<WorkspaceEntry[]> {
	const directory = await workspacePath(cwd, name);
	const entries = await readdir(directory, { withFileTypes: true });
	return entries.filter((entry) => entry.name !== ".git").map((entry): WorkspaceEntry => ({
		path: path.posix.join(name, entry.name), name: entry.name,
		kind: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
	})).sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
}

async function previewContent(file: string, signal: AbortSignal): Promise<FilePreview["content"]> {
	signal.throwIfAborted();
	const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile()) return { kind: "unavailable", reason: "仅支持预览普通文件。" };
		if (metadata.size > MAX_PREVIEW) return { kind: "unavailable", reason: "文件超过 512 KiB，未加载预览。" };
		const buffer = Buffer.alloc(MAX_PREVIEW + 1);
		let length = 0;
		while (length < buffer.length) {
			signal.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > MAX_PREVIEW) return { kind: "unavailable", reason: "文件超过 512 KiB，未加载预览。" };
		const data = buffer.subarray(0, length);
		const type = await fileTypeFromBuffer(data);
		if (type && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(type.mime))
			return { kind: "image", data: data.toString("base64"), mime: type.mime };
		if (data.includes(0)) return { kind: "unavailable", reason: "二进制文件不支持文本预览。" };
		try { return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(data) }; }
		catch { return { kind: "unavailable", reason: "文件不是 UTF-8 文本。" }; }
	} finally { await handle.close(); }
}

export async function previewWorkspaceFile(cwd: string, name: string, signal: AbortSignal, readGit = () => readWorkspaceGit(cwd, signal)): Promise<FilePreview> {
	const [file, git]: [string, WorkspaceGit | null] = await Promise.all([workspacePath(cwd, name, true), readGit()]);
	const change = git?.changes.find((item) => item.path === name);
	let content: FilePreview["content"];
	try { content = await previewContent(file, signal); }
	catch (error) {
		if (change?.status !== "D" || !(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		content = { kind: "deleted" };
	}
	const diffs: FilePreview["diffs"] = [];
	if (change?.status === "?" && content.kind === "text") {
		const lines = content.text.split("\n");
		if (lines.at(-1) === "") lines.pop();
		diffs.push({ title: "未跟踪", text: `--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n` });
	} else if (change) {
		const names = change.originalPath ? [name, change.originalPath] : [name];
		const args = ["--no-ext-diff", "--no-textconv", "--no-color", "--", ...names];
		const [staged, working] = await Promise.all([
			gitOutput(cwd, ["diff", "--cached", ...args], signal),
			gitOutput(cwd, ["diff", ...args], signal),
		]);
		if (staged) diffs.push({ title: "已暂存", text: staged });
		if (working) diffs.push({ title: "未暂存", text: working });
	}
	return { path: name, content, diffs };
}
