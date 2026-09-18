import { createReadStream, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import pLimit from "p-limit";
import type { GuiSessionInfo } from "../contract.ts";

const missing = (error: unknown) => error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

async function finishAll<T>(tasks: Promise<T>[]): Promise<T[]> {
	const results = await Promise.allSettled(tasks);
	return results.map((result) => {
		if (result.status === "rejected") throw result.reason;
		return result.value;
	});
}

async function summary(file: string, mtime: number): Promise<GuiSessionInfo | null> {
	const input = createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	let cwd: string | undefined;
	let created = mtime;
	let modified = 0;
	let name = "";
	let first = "";
	try {
		for await (const line of lines) {
			let entry: unknown;
			try { entry = JSON.parse(line); }
			catch (error) { if (error instanceof SyntaxError) continue; throw error; }
			if (!object(entry)) continue;
			if (cwd === undefined) {
				if (entry.type !== "session") return null;
				cwd = typeof entry.cwd === "string" ? entry.cwd : "";
				const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
				if (Number.isFinite(time)) created = time;
				continue;
			}
			if (entry.type === "session_info") name = typeof entry.name === "string" ? entry.name.trim() : "";
			if (entry.type !== "message" || !object(entry.message)) continue;
			const message = entry.message;
			if (message.role !== "user" && message.role !== "assistant") continue;
			const time = typeof message.timestamp === "number" ? message.timestamp
				: typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
			if (Number.isFinite(time)) modified = Math.max(modified, time);
			if (!first && message.role === "user") {
				const text = typeof message.content === "string" ? message.content
					: Array.isArray(message.content) ? message.content.flatMap((block: unknown) => object(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join(" ") : "";
				first = text.replace(/\s+/g, " ").slice(0, 160);
			}
		}
		return cwd === undefined ? null : { path: file, cwd, title: name || first || "(no messages)", modified: new Date(modified || created).toISOString() };
	} finally { lines.close(); input.destroy(); }
}

/** 只缓存列表元数据，未变化的历史不再读取正文。 */
export class GuiSessionIndex {
	private cache = new Map<string, { stamp: string; value: GuiSessionInfo | null }>();

	async list(): Promise<GuiSessionInfo[]> {
		const root = path.join(getAgentDir(), "sessions");
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
