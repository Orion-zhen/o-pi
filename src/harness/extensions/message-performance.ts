import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantPerformanceTracker } from "../message-performance/tracker.ts";

export default function messagePerformance(pi: ExtensionAPI): void {
	const tracker = createAssistantPerformanceTracker();
	const unsubscribe = [
		// 清除空闲期间缓存保温请求留下的起点，消息开始后独立保存本次计时。
		pi.on("turn_start", () => tracker.reset()),
		pi.on("before_provider_headers", () => tracker.startRequest()),
		pi.on("message_start", (event) => {
			if (event.message.role === "assistant") tracker.startMessage();
		}),
		pi.on("message_update", (event) => {
			if (event.message.role === "assistant") tracker.updateMessage(event.message, event.assistantMessageEvent);
		}),
		pi.on("message_end", (event) => {
			if (event.message.role === "assistant") tracker.endMessage(event.message);
		}),
	];
	pi.on("session_shutdown", () => {
		for (const off of unsubscribe) off();
		tracker.reset();
	});
}
