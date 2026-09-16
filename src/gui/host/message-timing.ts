import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { assistantKey } from "../message-metrics.ts";

/** 请求起点到模型消息结束，包含首字等待，不包含工具执行。 */
export class MessageTiming {
	readonly durations: Record<string, number> = {};
	private started: number | undefined;

	accept(event: AgentSessionEvent): void {
		if (event.type === "turn_start") this.started = performance.now();
		if (event.type === "message_end" && event.message.role === "assistant" && this.started !== undefined) {
			this.durations[assistantKey(event.message)] = performance.now() - this.started;
			this.started = undefined;
		}
		if (event.type === "agent_end") this.started = undefined;
	}
}
