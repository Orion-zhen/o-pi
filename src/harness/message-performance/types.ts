import type { AssistantMessage } from "@earendil-works/pi-ai";

export interface AssistantPerformance {
	/** 按 contentIndex 记录已结束正文的速度。缺键表示未观测到结束，null 表示无法估算。 */
	bodyTps: Record<number, number | null>;
	ttftWithThinkingMs: number | null;
	ttftWithoutThinkingMs: number | null;
}

export type MeasuredAssistantMessage = AssistantMessage & { opiPerformance?: AssistantPerformance };

export function getAssistantPerformance(message: MeasuredAssistantMessage): AssistantPerformance | undefined {
	return message.opiPerformance;
}
