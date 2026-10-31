import type { GuiMessage, GuiStandaloneMessage } from "../../../../shared/messages/types.ts";
import type { GuiSnapshot } from "../../../../shared/protocol/state.ts";
import type { replyMetrics } from "../messages/metrics.ts";
import { sameToolActivity, type ToolActivity } from "../tools/activity.ts";

export type TranscriptSource = Pick<GuiSnapshot, "models" | "streamingMessage" | "liveTools" | "streaming" | "retrying" | "compacting"> & { messages: GuiMessage[] };

export type TranscriptItem = { key: string; messageIndex: number } & (
	| { kind: "message"; message: GuiStandaloneMessage }
	| { kind: "text"; text: string; blockIndex: number; active: boolean;
		identity: { model: string; timestamp: number }; metrics: ReturnType<typeof replyMetrics>; speed: number | null }
	| { kind: "thinking"; text: string; active: boolean }
	| { kind: "tool"; tool: ToolActivity; pruned: boolean }
	| { kind: "error"; text: string }
);

/** 投影会重建包装对象，渲染只比较展示字段。正文、参数和结果沿用协议中的不可变引用。 */
export function sameTranscriptItem(before: TranscriptItem, after: TranscriptItem): boolean {
	if (before === after) return true;
	if (before.key !== after.key || before.messageIndex !== after.messageIndex) return false;
	switch (before.kind) {
		case "message": return after.kind === "message" && before.message === after.message;
		case "thinking": return after.kind === "thinking" && before.text === after.text && before.active === after.active;
		case "error": return after.kind === "error" && before.text === after.text;
		case "tool": return after.kind === "tool" && before.pruned === after.pruned && sameToolActivity(before.tool, after.tool);
		case "text": return after.kind === "text" && before.text === after.text && before.active === after.active && before.blockIndex === after.blockIndex
			&& before.identity.model === after.identity.model && before.identity.timestamp === after.identity.timestamp
			&& before.metrics.input === after.metrics.input && before.metrics.output === after.metrics.output
			&& before.metrics.cacheRead === after.metrics.cacheRead && before.metrics.cacheWrite === after.metrics.cacheWrite
			&& before.metrics.cost === after.metrics.cost && before.speed === after.speed;
	}
}
