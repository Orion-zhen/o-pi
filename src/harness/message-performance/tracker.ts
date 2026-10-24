import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { countTextTokensSync } from "../token-counter.ts";
import type { MeasuredAssistantMessage } from "./types.ts";

interface TextMeasurement {
	firstText: string;
	text: string;
	firstAt: number;
	lastAt: number;
}

interface ActiveMeasurement {
	requestStartedAt: number | undefined;
	firstThinkingAt?: number;
	firstTextAt?: number;
	texts: Map<number, TextMeasurement>;
	bodyTps: Record<number, number | null>;
}

/** 两端共用流式观测。只在正文结束时分词，避免分词开销影响到达时间。 */
export function createAssistantPerformanceTracker() {
	let requestStartedAt: number | undefined;
	let active = createMeasurement(undefined);

	return {
		startRequest(): void {
			requestStartedAt = performance.now();
		},

		startMessage(): void {
			active = createMeasurement(requestStartedAt);
			requestStartedAt = undefined;
		},

		updateMessage(message: AssistantMessage, event: AssistantMessageEvent): void {
			const at = performance.now();
			if (event.type === "thinking_delta" && event.delta.trim().length > 0) {
				active.firstThinkingAt ??= at;
			} else if (event.type === "thinking_end" && event.content.trim().length > 0) {
				active.firstThinkingAt ??= at;
			} else if (event.type === "text_delta" && event.delta.length > 0) {
				if (event.delta.trim().length > 0) active.firstTextAt ??= at;
				const text = active.texts.get(event.contentIndex);
				if (text) {
					text.text += event.delta;
					text.lastAt = at;
				} else {
					active.texts.set(event.contentIndex, { firstText: event.delta, text: event.delta, firstAt: at, lastAt: at });
				}
			} else if (event.type === "text_end") {
				if (event.content.trim().length > 0) active.firstTextAt ??= at;
				active.bodyTps[event.contentIndex] = textTps(active.texts.get(event.contentIndex), event.content, message);
				publish(active, message, event.partial);
			}
		},

		endMessage(message: AssistantMessage): void {
			publish(active, message);
			requestStartedAt = undefined;
			active = createMeasurement(undefined);
		},

		reset(): void {
			requestStartedAt = undefined;
			active = createMeasurement(undefined);
		},
	};
}

function createMeasurement(requestStartedAt: number | undefined): ActiveMeasurement {
	return { requestStartedAt, texts: new Map(), bodyTps: {} };
}

function textTps(text: TextMeasurement | undefined, content: string, message: AssistantMessage): number | null {
	// 单片段、缓冲后一次性返回或结束时改写正文，都无法推算生成区间。
	if (!text || text.lastAt <= text.firstAt || text.text !== content) return null;
	const scope = { provider: message.provider, modelId: message.model };
	const tokens = countTextTokensSync(content, scope).tokens - countTextTokensSync(text.firstText, scope).tokens;
	return tokens > 0 ? tokens * 1_000 / (text.lastAt - text.firstAt) : null;
}

function publish(active: ActiveMeasurement, ...messages: MeasuredAssistantMessage[]): void {
	const { requestStartedAt, firstTextAt, firstThinkingAt } = active;
	const firstVisibleAt = firstThinkingAt === undefined ? firstTextAt
		: firstTextAt === undefined ? firstThinkingAt : Math.min(firstThinkingAt, firstTextAt);
	const latency = (at: number | undefined) => at === undefined || requestStartedAt === undefined ? null : at - requestStartedAt;
	// 扩展事件先于 GUI/TUI 和会话落盘。元数据随消息保存，不依赖全局缓存。
	const measurement = {
		bodyTps: { ...active.bodyTps },
		ttftWithThinkingMs: latency(firstVisibleAt),
		ttftWithoutThinkingMs: latency(firstTextAt),
	};
	for (const message of messages) message.opiPerformance = measurement;
}
