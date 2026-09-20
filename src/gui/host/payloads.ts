import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { GuiQueryResults, GuiSnapshot } from "../contract.ts";
import { toolFacts } from "../tool-facts.ts";
import { isSkillLoadDetails } from "../skill-facts.ts";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 载荷仅在当前会话内有效，不暴露文件路径。历史对象按引用复用。 */
export class GuiPayloads {
	private cache = new WeakMap<object, unknown>();
	private images = new Map<string, string>();
	private outputs = new Map<string, GuiQueryResults["toolOutput"]>();

	image(id: string): string {
		const data = this.images.get(id);
		if (data === undefined) throw new Error("图片已失效，请重新打开会话。");
		return data;
	}

	toolOutput(id: string): GuiQueryResults["toolOutput"] {
		const output = this.outputs.get(id);
		if (!output) throw new Error("工具结果已失效，请重新打开会话。");
		return output;
	}

	snapshot(value: GuiSnapshot): GuiSnapshot {
		return { ...value, messages: value.messages.map((message) => this.project(message)),
			entries: value.entries.map((entry) => this.project(entry)),
			streamingMessage: this.stream(value.streamingMessage),
			liveTools: value.liveTools.map((event) => this.copy(event)),
		};
	}

	stream(message: AgentMessage | null): AgentMessage | null {
		// SDK 的进行中对象可变，不能使用历史缓存。
		return message ? this.copy(message) : null;
	}

	project<T>(value: T): T {
		return this.transform(value, true) as T;
	}

	private copy<T>(value: T): T {
		return this.transform(value, false) as T;
	}

	private transform(value: unknown, cache: boolean): unknown {
		if (typeof value !== "object" || value === null) return value;
		if (cache && this.cache.has(value)) return this.cache.get(value);
		let result: unknown;
		if (Array.isArray(value)) result = value.map((item: unknown) => this.transform(item, cache));
		else if (record(value) && value.role === "toolResult" && JSON.stringify(value).length > 64_000) {
			const id = randomUUID();
			this.outputs.set(id, { content: value.content, details: value.details });
			const details = record(value.details) ? value.details : {};
			const preview = {
				...(value.toolName === "skill" && isSkillLoadDetails(details) ? details : {}),
				guiOutputId: id,
				guiFacts: toolFacts({ name: String(value.toolName), args: undefined, output: { content: value.content, details } }),
				status: details.status, error: details.error,
			};
			const first = Array.isArray(value.content) ? value.content.find((block: unknown) => record(block) && block.type === "text") : undefined;
			result = { ...value, details: preview, content: record(first) && typeof first.text === "string" ? [{ type: "text", text: first.text.slice(0, 240) }] : [] };
		} else if (record(value)) {
			const image = typeof value.data === "string" && [value.mimeType, value.mime_type, value.mediaType].some((mime) => typeof mime === "string" && mime.startsWith("image/"));
			const data = value.data;
			let reference: string | undefined;
			if (image && typeof data === "string") {
				const id = randomUUID();
				this.images.set(id, data);
				reference = `opi-image:${id}`;
			}
			result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "data" && reference ? reference : this.transform(item, cache)]));
		}
		if (cache) this.cache.set(value, result);
		return result;
	}
}
