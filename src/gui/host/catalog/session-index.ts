import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getSessionsDir } from "../../../harness/storage/sdk-paths.ts";
import pLimit from "p-limit";
import type { GuiSessionInfo } from "../../shared/protocol/state.ts";
import { readSessionFile } from "./session-reader.ts";

const missing = (error: unknown) => error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
interface IndexedSession { path: string; cwd: string; summary: GuiSessionInfo | undefined }

async function finishAll<T>(tasks: Promise<T>[]): Promise<T[]> {
	const results = await Promise.allSettled(tasks);
	return results.map((result) => {
		if (result.status === "rejected") throw result.reason;
		return result.value;
	});
}

async function summary(file: string, mtime: number, scope: ReadonlySet<string> | undefined, signal: AbortSignal | undefined, read: typeof readSessionFile): Promise<IndexedSession | null> {
	let cwd: string | undefined;
	let created = mtime;
	let modified = 0;
	let name = "";
	let first = "";
	let text = "";
	let block = "";
	let blocks = 0;
	await read(file, {
		start() { text = ""; blocks = 0; },
		textStart() { block = ""; },
		text(chunk) { if (!first && block.length < 160) block = (block + chunk.replace(/\s+/g, " ")).replace(/ {2,}/g, " ").slice(0, 160); },
		textEnd(type) { if (type === "text") text = (text + (blocks++ ? " " : "") + block).replace(/ {2,}/g, " ").slice(0, 160); },
		record(entry) {
			if (cwd === undefined) {
				if (entry.type !== "session") return true;
				cwd = entry.cwd;
				const time = Date.parse(entry.timestamp);
				if (Number.isFinite(time)) created = time;
				return scope !== undefined && !scope.has(cwd);
			}
			if (entry.type === "session_info") name = entry.name.trim();
			if (entry.type !== "message" || entry.role !== "user" && entry.role !== "assistant") return false;
			const time = entry.messageTimestamp ?? Date.parse(entry.timestamp);
			if (Number.isFinite(time)) modified = Math.max(modified, time);
			if (!first && entry.role === "user") first = text;
			return false;
		},
	}, signal);
	return cwd === undefined ? null : {
		path: file, cwd,
		summary: scope !== undefined && !scope.has(cwd) ? undefined
			: { path: file, cwd, title: name || first || "(no messages)", modified: new Date(modified || created).toISOString() },
	};
}

/** 每次直读磁盘。只解析请求工作区的摘要，其他工作区在文件头结束读取。 */
export async function readSessionIndex(workspaces?: readonly string[], signal?: AbortSignal, read = readSessionFile) {
	signal?.throwIfAborted();
	const scope = workspaces === undefined ? undefined : new Set(workspaces);
	const root = getSessionsDir();
	const limit = pLimit(10);
	let directories: Dirent[];
	try { directories = await readdir(root, { withFileTypes: true }); }
	catch (error) { if (!missing(error)) throw error; directories = []; }
	const files = (await finishAll(directories.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => limit(async () => {
		const directory = path.join(root, entry.name);
		try { return (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(directory, name)); }
		catch (error) { if (missing(error)) return []; throw error; }
	})))).flat();
	const values = await finishAll(files.map((file) => limit(async () => {
		try {
			signal?.throwIfAborted();
			const metadata = await stat(file);
			return metadata.isFile() ? await summary(file, metadata.mtimeMs, scope, signal, read) : null;
		} catch (error) { if (missing(error)) return null; throw error; }
	})));
	return {
		files: values.flatMap((value) => value ? [{ path: value.path, cwd: value.cwd }] : []),
		sessions: values.flatMap((value) => value?.summary ? [value.summary] : []).sort((a, b) => b.modified.localeCompare(a.modified)),
	};
}

export async function readSessionPaths(cwd?: string): Promise<Set<string>> {
	const { files } = await readSessionIndex([]);
	return new Set(files.filter((file) => cwd === undefined || file.cwd === cwd).map((file) => file.path));
}
