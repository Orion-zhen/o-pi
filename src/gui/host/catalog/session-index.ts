import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getSessionsDir } from "../../../harness/storage/sdk-paths.ts";
import pLimit from "p-limit";
import type { GuiSessionInfo } from "../../shared/protocol/state.ts";
import { readSessionFile } from "./session-reader.ts";

const missing = (error: unknown) => error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

async function finishAll<T>(tasks: Promise<T>[]): Promise<T[]> {
	const results = await Promise.allSettled(tasks);
	return results.map((result) => {
		if (result.status === "rejected") throw result.reason;
		return result.value;
	});
}

async function summary(file: string, mtime: number): Promise<GuiSessionInfo | null> {
	let cwd: string | undefined;
	let created = mtime;
	let modified = 0;
	let name = "";
	let first = "";
	let text = "";
	let block = "";
	let blocks = 0;
	await readSessionFile(file, {
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
				return false;
			}
			if (entry.type === "session_info") name = entry.name.trim();
			if (entry.type !== "message" || entry.role !== "user" && entry.role !== "assistant") return false;
			const time = entry.messageTimestamp ?? Date.parse(entry.timestamp);
			if (Number.isFinite(time)) modified = Math.max(modified, time);
			if (!first && entry.role === "user") first = text;
			return false;
		},
	});
	return cwd === undefined ? null : { path: file, cwd, title: name || first || "(no messages)", modified: new Date(modified || created).toISOString() };
}

/** 只缓存列表元数据，未变化的历史不再读取正文。 */
export class GuiSessionIndex {
	private cache = new Map<string, { stamp: string; value: GuiSessionInfo | null }>();

	async list(): Promise<GuiSessionInfo[]> {
		const root = getSessionsDir();
		const limit = pLimit(10);
		let directories: Dirent[];
		try { directories = await readdir(root, { withFileTypes: true }); }
		catch (error) { if (!missing(error)) throw error; this.cache.clear(); return []; }
		const files = (await finishAll(directories.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => limit(async () => {
			const directory = path.join(root, entry.name);
			try { return (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(directory, name)); }
			catch (error) { if (missing(error)) return []; throw error; }
		})))).flat();
		const retained = new Set(files);
		for (const file of this.cache.keys()) if (!retained.has(file)) this.cache.delete(file);
		const values = await finishAll(files.map((file) => limit(async () => {
			try {
				const metadata = await stat(file);
				if (!metadata.isFile()) return null;
				const stamp = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
				const cached = this.cache.get(file);
				if (cached?.stamp === stamp) return cached.value;
				const value = await summary(file, metadata.mtimeMs);
				this.cache.set(file, { stamp, value });
				return value;
			} catch (error) { if (missing(error)) { this.cache.delete(file); return null; } throw error; }
		})));
		return values.filter((value) => value !== null).sort((a, b) => b.modified.localeCompare(a.modified));
	}
}
