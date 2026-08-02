import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { countTextTokensSync } from "../token-counter.js";

export interface AssistantPerformance {
	bodyTps: number;
	ttftWithThinkingMs: number;
	ttftWithoutThinkingMs: number;
}

interface ActiveMeasurement {
	messageKey?: string;
	requestStartedAt: number;
	firstThinkingAt?: number;
	firstTextAt?: number;
	lastTextAt?: number;
}

const completedMeasurements = new Map<string, AssistantPerformance>();

/** 跟踪一次 native TUI 会话中的模型请求；计时使用单调时钟，避免系统时间调整。 */
export function createAssistantPerformanceTracker(now: () => number = () => performance.now()) {
	let active: ActiveMeasurement | undefined;

	return {
		startRequest(): void {
			active = { requestStartedAt: now() };
		},

		startMessage(message: AssistantMessage): void {
			if (active === undefined) return;
			active.messageKey = messageKey(message);
		},

		updateMessage(message: AssistantMessage, event: AssistantMessageEvent): void {
			if (active?.messageKey !== messageKey(message)) return;
			const at = now();
			if (event.type === "thinking_delta" && event.delta.trim().length > 0) {
				active.firstThinkingAt ??= at;
			} else if (event.type === "thinking_end" && active.firstThinkingAt === undefined && event.content.trim().length > 0) {
				active.firstThinkingAt = at;
			} else if (event.type === "text_delta" && event.delta.trim().length > 0) {
				active.firstTextAt ??= at;
				active.lastTextAt = at;
			} else if (event.type === "text_end" && active.firstTextAt === undefined && event.content.trim().length > 0) {
				active.firstTextAt = at;
				active.lastTextAt = at;
			}
		},

		endMessage(message: AssistantMessage): void {
			if (active?.messageKey !== messageKey(message)) return;
			const measurement = finalizeMeasurement(active, message);
			if (measurement !== undefined) completedMeasurements.set(active.messageKey, measurement);
			active = undefined;
		},

		reset(): void {
			active = undefined;
			completedMeasurements.clear();
		},
	};
}

export function getAssistantPerformance(message: AssistantMessage): AssistantPerformance | undefined {
	return completedMeasurements.get(messageKey(message));
}

export function resetAssistantPerformanceMeasurements(): void {
	completedMeasurements.clear();
}

function finalizeMeasurement(active: ActiveMeasurement, message: AssistantMessage): AssistantPerformance | undefined {
	const { firstTextAt, lastTextAt } = active;
	if (
		firstTextAt === undefined
		|| lastTextAt === undefined
		|| lastTextAt <= firstTextAt
		|| message.stopReason === "error"
		|| message.stopReason === "aborted"
	) return undefined;

	const body = message.content
		.flatMap((content) => content.type === "text" ? [content.text] : [])
		.join("\n");
	const bodyTokens = countTextTokensSync(body, { provider: message.provider, modelId: message.model }).tokens;
	if (bodyTokens <= 0) return undefined;

	const firstVisibleAt = Math.min(active.firstThinkingAt ?? firstTextAt, firstTextAt);
	return {
		bodyTps: bodyTokens / ((lastTextAt - firstTextAt) / 1_000),
		ttftWithThinkingMs: Math.max(0, firstVisibleAt - active.requestStartedAt),
		ttftWithoutThinkingMs: Math.max(0, firstTextAt - active.requestStartedAt),
	};
}

function messageKey(message: AssistantMessage): string {
	return `${message.timestamp}\0${message.provider}\0${message.model}`;
}
