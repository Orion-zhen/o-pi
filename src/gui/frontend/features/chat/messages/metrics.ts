import type { AssistantMessage } from "@earendil-works/pi-ai";

export function replyMetrics(messages: AssistantMessage[]) {
	let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0, duration = 0;
	let timed = messages.length > 0;
	for (const message of messages) {
		input += message.usage.input;
		output += message.usage.output;
		cacheRead += message.usage.cacheRead;
		cacheWrite += message.usage.cacheWrite;
		cost += message.usage.cost.total;
		const ms = message.durationMs;
		if (ms === undefined) timed = false;
		else duration += ms;
	}
	return { input, output, cacheRead, cacheWrite, cost, speed: timed && duration > 0 ? output * 1000 / duration : null };
}
