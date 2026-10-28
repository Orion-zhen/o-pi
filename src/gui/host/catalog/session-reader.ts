import { createReadStream } from "node:fs";
import { none } from "stream-chain/defs.js";
import { jsonParser, type Token } from "stream-json/core/parser.js";

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
type Kind = "record" | "message" | "blocks" | "block" | "other";
type Target = Exclude<keyof SessionRecord, "messageTimestamp"> | "blockType" | "text" | undefined;
interface Frame { kind: Kind; key: string; type: string; hasText: boolean }
const frame = (kind: Kind): Frame => ({ kind, key: "", type: "", hasText: false });
const emptyRecord = (): SessionRecord => ({ type: "", cwd: "", name: "", timestamp: "", role: "", messageTimestamp: undefined });

function stringTarget({ kind, key }: Frame): Target {
	switch (kind) {
		case "record":
			switch (key) {
				case "type": case "cwd": case "name": case "timestamp": return key;
			}
			break;
		case "message":
			if (key === "role") return "role";
			if (key === "content") return "text";
			break;
		case "block":
			if (key === "type") return "blockType";
			if (key === "text") return "text";
	}
}

/** 按行重置 tokenizer，但从不拼接整行，损坏记录与未写完的尾行沿用目录读取的跳过语义。 */
export async function readSessionFile(file: string, reader: SessionReader, signal?: AbortSignal): Promise<void> {
	const input = createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024, signal });
	const closed = new Promise<void>((resolve) => input.once("close", resolve));
	let parse = tokenizer();
	let stack: Frame[] = [];
	let value = emptyRecord();
	let target: Target;
	let complete = false;
	let invalid = false;
	let hasData = false;
	reader.start();

	function tokenizer() {
		return jsonParser({ packKeys: true, packStrings: false, packNumbers: true, streamKeys: false, streamNumbers: false });
	}
	function reset() {
		parse = tokenizer(); stack = []; value = emptyRecord(); target = undefined; complete = false; invalid = false; hasData = false;
		reader.start();
	}
	function consume(token: Token) {
		const parent = stack.at(-1);
		switch (token.name) {
			case "startObject": case "startArray": {
				let kind: Kind = "other";
				if (token.name === "startObject") {
					if (!parent) kind = "record";
					else if (parent.kind === "record" && parent.key === "message") kind = "message";
					else if (parent.kind === "blocks") kind = "block";
				} else if (parent?.kind === "message" && parent.key === "content") kind = "blocks";
				stack.push(frame(kind));
				break;
			}
			case "endObject": case "endArray": {
				const ended = stack.pop();
				if (ended?.kind === "block" && ended.hasText) reader.textEnd(ended.type);
				if (ended?.kind === "record") complete = true;
				break;
			}
			case "keyValue": if (parent) parent.key = token.value; break;
			case "startString": {
				target = undefined;
				if (!parent) break;
				target = stringTarget(parent);
				switch (target) {
					case undefined: break;
					case "text": parent.hasText = true; reader.textStart(value.role); break;
					case "blockType": parent.type = ""; break;
					default: value[target] = "";
				}
				break;
			}
			case "stringChunk": {
				switch (target) {
					case "text": reader.text(token.value); break;
					case "blockType": if (parent) parent.type = (parent.type + token.value).slice(0, 64); break;
					case "type": case "role": case "timestamp": value[target] = (value[target] + token.value).slice(0, 64); break;
					case "cwd": case "name": value[target] += token.value; break;
				}
				break;
			}
			case "endString": {
				if (target === "text" && parent?.kind === "message") reader.textEnd("text");
				target = undefined; break;
			}
			case "numberValue": if (parent?.kind === "message" && parent.key === "timestamp") value.messageTimestamp = Number(token.value); break;
		}
	}
	function feed(chunk: string | typeof none) {
		if (invalid) return;
		let tokens: ReturnType<typeof parse>;
		try { tokens = parse(chunk); }
		catch (error) {
			if (!(error instanceof Error) || !error.message.startsWith("Parser ")) throw error;
			invalid = true; return;
		}
		if (tokens !== none) for (const token of tokens.values) consume(token);
	}
	function finish(): boolean {
		if (!hasData) return false;
		feed(none);
		return !invalid && complete && reader.record(value);
	}
	try {
		for await (const chunk of input as AsyncIterable<string>) {
			signal?.throwIfAborted();
			let start = 0;
			while (start < chunk.length) {
				const end = chunk.indexOf("\n", start);
				const part = chunk.slice(start, end < 0 ? chunk.length : end);
				if (part.length) { hasData = true; feed(part); }
				if (end < 0) break;
				if (finish()) return;
				reset(); start = end + 1;
			}
		}
		finish();
	} finally { input.destroy(); await closed; }
}
