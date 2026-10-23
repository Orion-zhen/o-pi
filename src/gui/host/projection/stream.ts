import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { GuiMessage } from "../../shared/messages/types.ts";
import type { GuiPayloads } from "./payloads.ts";

type ContentEvent = Extract<AssistantMessageEvent, { contentIndex: number }>;
type Block = AssistantMessage["content"][number];

/** partial 是共享活对象。正文按事件追加，只有观察者读取时才冻结元数据和变化的工具参数。 */
export class GuiStream {
	private message: AgentMessage | null = null;
	private pending = new Map<number, Block>();
	private projected: GuiMessage | null = null;

	constructor(private payloads: GuiPayloads) {}

	start(message: AgentMessage): void {
		this.end();
		this.message = message;
	}

	end(): void {
		this.message = this.projected = null;
		this.pending.clear();
	}

	update(event: ContentEvent): boolean {
		const index = event.contentIndex;
		const previous = this.pending.get(index) ?? (this.projected?.role === "assistant" ? this.projected.content[index] : undefined);
		const source = event.partial.content[index];
		let block: Block;
		let appendOnly = false;
		switch (event.type) {
			case "text_delta":
				if (previous?.type !== "text") throw new Error("流式正文块不存在。");
				block = { ...previous, text: previous.text + event.delta };
				appendOnly = true;
				break;
			case "thinking_delta":
				if (previous?.type !== "thinking") throw new Error("流式思考块不存在。");
				block = { ...previous, thinking: previous.thinking + event.delta };
				appendOnly = true;
				break;
			case "text_start":
			case "text_end":
				if (source?.type !== "text") throw new Error("SDK 正文块无效。");
				block = { ...source, text: event.type === "text_end" ? event.content : "" };
				break;
			case "thinking_start":
			case "thinking_end":
				if (source?.type !== "thinking") throw new Error("SDK 思考块无效。");
				block = { ...source, thinking: event.type === "thinking_end" ? event.content : source.redacted ? source.thinking : "" };
				break;
			case "toolcall_start":
			case "toolcall_delta":
				if (source?.type !== "toolCall") throw new Error("SDK 工具调用块无效。");
				block = source;
				break;
			case "toolcall_end":
				block = event.toolCall;
				break;
		}
		appendOnly &&= this.pending.size === 0 && this.projected !== null;
		this.pending.set(index, block);
		this.message = event.partial;
		return appendOnly;
	}

	project(): GuiMessage | null {
		if (!this.message || this.projected && !this.pending.size) return this.projected;
		if (this.message.role !== "assistant") this.projected = this.payloads.message(structuredClone(this.message));
		else {
			const content = this.projected?.role === "assistant" ? [...this.projected.content] : [];
			for (const [index, block] of this.pending) content[index] = block.type === "toolCall" ? structuredClone(block) : block;
			const { content: _content, ...metadata } = this.message;
			this.projected = { ...structuredClone(metadata), content };
		}
		this.pending.clear();
		return this.projected;
	}
}
