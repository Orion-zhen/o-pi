import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import {
	getAgentDir,
	parseSessionEntries,
	type AgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { GuiEvent } from "../contract.ts";

const MAX_ATTACHMENT = 8 * 1024 * 1024;
export async function expandAttachments(text: string, cwd: string): Promise<{ text: string; images: ImageContent[] }> {
	const images: ImageContent[] = [];
	const contents: string[] = [];
	const paths = [...text.matchAll(/(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g)].map(
		(match) => match[1] ?? match[2] ?? match[3],
	);
	for (const reference of paths) {
		if (!reference) continue;
		const file = path.resolve(cwd, reference);
		const metadata = await stat(file);
		if (!metadata.isFile()) throw new Error(`附件必须是普通文件: ${reference}`);
		if (metadata.size > MAX_ATTACHMENT) throw new Error(`附件超过 8 MiB: ${reference}`);
		const data = await readFile(file);
		const format = await fileTypeFromBuffer(data);
		if (format?.mime.startsWith("image/")) {
			images.push({ type: "image", data: data.toString("base64"), mimeType: format.mime });
		} else if (data.includes(0)) {
			contents.push(`附件位于 ${file}。使用 read 工具读取此文件。`);
		} else contents.push(`<file path=${JSON.stringify(reference)}>\n${data.toString("utf8")}\n</file>`);
	}
	return { text: [text, ...contents].join("\n\n"), images };
}

export async function completeFiles(cwd: string, prefix: string): Promise<string[]> {
	const directory = prefix.endsWith("/") ? prefix : path.dirname(prefix);
	const base = prefix.endsWith("/") ? "" : path.basename(prefix);
	const entries = await readdir(path.resolve(cwd, directory), { withFileTypes: true });
	return entries
		.filter((entry) => entry.name.startsWith(base))
		.slice(0, 100)
		.map((entry) => `${directory === "." ? "" : `${directory}/`}${entry.name}${entry.isDirectory() ? "/" : ""}`);
}

export async function exportSession(
	session: AgentSession,
	format: "jsonl" | "html",
	emit: (event: GuiEvent) => void,
): Promise<void> {
	const directory = await mkdtemp(path.join(tmpdir(), "opi-export-"));
	try {
		const file = path.join(directory, `session.${format}`);
		if (format === "jsonl") session.exportToJsonl(file);
		else await session.exportToHtml(file);
		emit({
			type: "download",
			name: `${session.sessionId}.${format}`,
			content: await readFile(file, "utf8"),
			mimeType: format === "html" ? "text/html" : "application/x-ndjson",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export async function importSession(content: string): Promise<SessionManager> {
	const entries = parseSessionEntries(content);
	const header = entries.find((entry) => entry.type === "session");
	if (!header) throw new Error("无效会话 JSONL，缺少 session header。");
	if (!(await stat(header.cwd)).isDirectory()) throw new Error("工作目录不是文件夹。");
	const manager = SessionManager.create(header.cwd);
	const file = manager.getSessionFile();
	if (!file) throw new Error("未能创建导入会话。");
	await mkdir(path.dirname(file), { recursive: true });
	// 导入是独立会话，不能与仍在运行的源会话共用标识。
	const imported = entries.map((entry) => entry.type === "session" ? { ...entry, id: manager.getSessionId() } : entry);
	await writeFile(file, imported.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600, flag: "wx" });
	return SessionManager.open(file);
}

export async function readConfig(file: "settings.json"): Promise<string> {
	const fullPath = path.join(getAgentDir(), file);
	try {
		return await readFile(fullPath, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
		throw error;
	}
}

export async function saveConfig(file: "settings.json", original: string, content: string): Promise<void> {
	const parsed: unknown = JSON.parse(content);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("设置必须是 JSON 对象。");
	await replaceConfigFile(path.join(getAgentDir(), file), original, content);
}

export async function replaceConfigFile(target: string, original: string, content: string): Promise<void> {
	await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		// 在同一个同步片段中检查版本并原子替换，拒绝覆盖界面打开后的修改。
		let current: string;
		try {
			current = readFileSync(target, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") current = "";
			else throw error;
		}
		if (current !== original) throw new Error("设置文件已被修改，请重新打开后编辑。");
		writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
	} finally {
		await rm(temporary, { force: true });
	}
}
