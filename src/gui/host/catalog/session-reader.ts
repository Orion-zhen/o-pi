import { createReadStream } from "node:fs";

export interface SessionRecord {
	type: string;
	cwd: string;
	name: string;
	timestamp: string;
	role: string;
	messageTimestamp: number | undefined;
}
export interface SessionReader {
	start(): void;
	textStart(role: string): void;
	text(chunk: string): void;
	textEnd(type: string): void;
	/** 只提交完整且有效的 JSONL 记录。返回 true 提前结束文件读取。 */
	record(value: SessionRecord): boolean;
}
const chunkSize = 64 * 1024;
const string = (value: unknown): string => typeof value === "string" ? value : "";
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function readLine(line: string, reader: SessionReader): boolean {
	if (!line.trim()) return false;
	let value: unknown;
	try { value = JSON.parse(line); }
	catch (error) { if (error instanceof SyntaxError) return false; throw error; }
	if (!object(value)) return false;
	const message = object(value.message) ? value.message : undefined;
	const role = string(message?.role);
	const content: unknown = message?.content;
	reader.start();
	function text(value: string, type: string) {
		reader.textStart(role);
		// 分块交给搜索，避免长正文的 Unicode 转换和摘要扫描再次放大内存。
		for (let start = 0; start < value.length; start += chunkSize) reader.text(value.slice(start, start + chunkSize));
		reader.textEnd(type);
	}
	if (typeof content === "string") text(content, "text");
	else if (Array.isArray(content)) {
		for (const block of content) if (object(block) && typeof block.text === "string") text(block.text, string(block.type));
	}
	return reader.record({
		type: string(value.type), cwd: string(value.cwd), name: string(value.name), timestamp: string(value.timestamp), role,
		messageTimestamp: typeof message?.timestamp === "number" ? message.timestamp : undefined,
	});
}

/** 流式读取并逐行解析，跳过损坏记录和未写完的尾行。 */
export async function readSessionFile(file: string, reader: SessionReader, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	const input = createReadStream(file, { encoding: "utf8", highWaterMark: chunkSize, signal });
	const closed = new Promise<void>((resolve) => input.once("close", resolve));
	let parts: string[] = [];
	try {
		for await (const chunk of input as AsyncIterable<string>) {
			signal?.throwIfAborted();
			let start = 0;
			while (start < chunk.length) {
				const end = chunk.indexOf("\n", start);
				if (end < 0) { parts.push(chunk.slice(start)); break; }
				let line = chunk.slice(start, end);
				if (parts.length) { parts.push(line); line = parts.join(""); parts = []; }
				if (readLine(line, reader)) return;
				start = end + 1;
			}
		}
		if (parts.length) readLine(parts.join(""), reader);
	} finally { input.destroy(); await closed; }
}
