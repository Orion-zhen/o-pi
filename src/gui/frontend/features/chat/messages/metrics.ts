import type { AssistantMessage } from "@earendil-works/pi-ai";

export function replyMetrics(messages: AssistantMessage[]) {
	let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
	for (const message of messages) {
		input += message.usage.input;
		output += message.usage.output;
		cacheRead += message.usage.cacheRead;
		cacheWrite += message.usage.cacheWrite;
		cost += message.usage.cost.total;
	}
	const costFromProvider = messages.length > 0 && messages.every((message) => message.usage.cost.totalFromProvider === true);
	return { input, output, cacheRead, cacheWrite, cost, costFromProvider };
}
