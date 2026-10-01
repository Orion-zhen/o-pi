import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import type { WorkspacePreview, WorkspaceEntry, WorkspaceGit } from "../workbench.ts";
import { workspacePath } from "./workspace-path.ts";
import { fileVersion } from "./file-resource.ts";
import { gitOutput, readWorkspaceGit } from "./workspace-git.ts";

const MAX_PREVIEW = 512 * 1024;

export async function listWorkspaceFiles(cwd: string, name: string): Promise<WorkspaceEntry[]> {
	const directory = await workspacePath(cwd, name);
	const entries = await readdir(directory, { withFileTypes: true });
	return entries.filter((entry) => entry.name !== ".git").map((entry): WorkspaceEntry => ({
		path: path.posix.join(name, entry.name), name: entry.name,
		kind: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
	})).sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
}

async function previewContent(file: string, signal: AbortSignal): Promise<WorkspacePreview["content"]> {
	signal.throwIfAborted();
	const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	try {
		const metadata = await handle.stat({ bigint: true });
		if (!metadata.isFile()) return { kind: "unavailable", reason: "仅支持预览普通文件。" };
		const head = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(head, 0, head.length, 0);
		const prefix = head.subarray(0, bytesRead);
		const type = await fileTypeFromBuffer(prefix);
		const svg = (!type || type.mime === "application/xml") && /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[^>]*>\s*)?<svg[\s>]/i.test(prefix.toString("utf8"));
		const mime = svg ? "image/svg+xml" : type?.mime;
		if (mime && ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "application/pdf"].includes(mime))
			return { kind: mime === "application/pdf" ? "pdf" : "image", mime, size: Number(metadata.size), version: fileVersion(metadata) };
		if (metadata.size > MAX_PREVIEW) return { kind: "unavailable", reason: "文件超过 512 KiB，未加载预览。" };
		const buffer = Buffer.alloc(MAX_PREVIEW + 1);
		let length = 0;
		while (length < buffer.length) {
			signal.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > MAX_PREVIEW) return { kind: "unavailable", reason: "文件超过 512 KiB，未加载预览。" };
		const data = buffer.subarray(0, length);
		if (data.includes(0)) return { kind: "unavailable", reason: "二进制文件不支持文本预览。" };
		try { return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(data) }; }
		catch { return { kind: "unavailable", reason: "文件不是 UTF-8 文本。" }; }
	} finally { await handle.close(); }
}

export async function previewWorkspaceFile(cwd: string, name: string, signal: AbortSignal, readGit = () => readWorkspaceGit(cwd, signal)): Promise<WorkspacePreview> {
	const [file, git]: [string, WorkspaceGit | null] = await Promise.all([workspacePath(cwd, name, true), readGit()]);
	const change = git?.changes.find((item) => item.path === name);
	let content: WorkspacePreview["content"];
	try { content = await previewContent(file, signal); }
	catch (error) {
		if (change?.status !== "D" || !(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		content = { kind: "deleted" };
	}
	const diffs: WorkspacePreview["diffs"] = [];
	if (change?.status === "?" && content.kind === "text") {
		const lines = content.text.split("\n");
		if (lines.at(-1) === "") lines.pop();
		const header = `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n`;
		const hunk = lines.length ? `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n` : "";
		diffs.push({ title: "未跟踪", text: header + hunk });
	} else if (change && content.kind !== "image" && content.kind !== "pdf") {
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
