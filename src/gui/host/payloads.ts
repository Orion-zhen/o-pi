import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { GuiContent, GuiImage, GuiMessage, GuiToolOutput, ToolOutput } from "../messages.ts";
import { toolFacts } from "../tool-facts.ts";
import { isSkillLoadDetails } from "../skill-facts.ts";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INLINE_LIMIT = 64_000;
const oversized = Symbol("oversized");

/** 按 JSON 长度下界提前停止，避免为大小判断复制整份大正文。小结果仍按实际编码长度判断。 */
function fitsInline(value: ToolOutput): boolean {
	let remaining = INLINE_LIMIT;
	try {
		return JSON.stringify(value, function (this: unknown, key: string, item: unknown) {
			if (typeof item === "string") remaining -= item.length + 2;
			else if (typeof item === "number") remaining -= Number.isFinite(item) ? String(item).length : 4;
			else if (typeof item === "boolean") remaining -= item ? 4 : 5;
			else if (typeof item === "object") remaining -= item === null ? 4 : 2;
			else return item;
			if (key && !Array.isArray(this)) remaining -= key.length + 3;
			if (remaining < 0) throw oversized;
			return item;
		}).length <= INLINE_LIMIT;
	} catch (error) {
		if (error === oversized) return false;
		throw error;
	}
}

/** 只投影协议定义的正文和图片，不递归改写扩展 details 或工具参数。 */
export class GuiPayloads {
	private images = new Map<string, string>();
	private outputs = new Map<string, ToolOutput>();

	image(id: string): string {
		const data = this.images.get(id);
		if (data === undefined) throw new Error("图片已失效，请重新打开会话。");
		return data;
	}
	toolOutput(id: string): ToolOutput {
		const output = this.outputs.get(id);
		if (!output) throw new Error("工具结果已失效，请重新打开会话。");
		return output;
	}
	private imageReference(image: ImageContent): GuiImage {
		const id = randomUUID();
		this.images.set(id, image.data);
		return { type: "image", mimeType: image.mimeType, imageId: id };
	}
	private content(content: string | (TextContent | ImageContent)[]): GuiContent {
		return typeof content === "string" ? content : content.map((block) => block.type === "image" ? this.imageReference(block) : block);
	}
	output(name: string, output: ToolOutput): GuiToolOutput {
		// 工具结果的 content 是扩展边界，只识别顶层的标准图片块。
		const content: unknown = Array.isArray(output.content) ? output.content.map((block: unknown) =>
			record(block) && block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string"
				? this.imageReference({ type: "image", data: block.data, mimeType: block.mimeType }) : block) : output.content;
		const value = { content, details: output.details };
		if (fitsInline(value)) return { kind: "inline", value };
		const id = randomUUID();
		this.outputs.set(id, value);
		const details = record(output.details) ? output.details : {};
		const first = Array.isArray(content) ? content.find((block: unknown) => record(block) && block.type === "text") : undefined;
		return {
			kind: "reference", id, facts: toolFacts({ name, args: undefined, output: value }),
			preview: {
				content: record(first) && typeof first.text === "string" ? [{ type: "text", text: first.text.slice(0, 240) }] : [],
				details: name === "skill" && isSkillLoadDetails(details) ? details : { status: details.status, error: details.error },
			},
		};
	}
	stream(message: AgentMessage | null): GuiMessage | null {
		// SDK 的进行中对象可变，历史缓存只能用于已落盘消息。
		return message ? this.message(structuredClone(message)) : null;
	}
	message(message: AgentMessage): GuiMessage {
		switch (message.role) {
			case "user":
			case "custom": return { ...message, content: this.content(message.content) };
			case "toolResult": {
				const { content, details, ...fields } = message;
				return { ...fields, output: this.output(message.toolName, { content, details }) };
			}
			default: return message;
		}
	}
}
