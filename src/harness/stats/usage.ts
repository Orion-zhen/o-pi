import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CacheStats, UsageStats } from "./types.js";

/** TUI 与 /stats 共用同一轮遍历和缓存命中率口径。 */
export function summarizeUsage(messages: readonly AgentMessage[]): { usage: UsageStats; cache: CacheStats } {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let costUsd = 0;
	let lastTurnTokens: number | undefined;
	let lastCostUsd: number | undefined;
	let latestHitRate: number | undefined;
	let assistantTurns = 0;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		assistantTurns += 1;
		const usage = message.usage;
		inputTokens += usage.input;
		outputTokens += usage.output;
		cacheReadTokens += usage.cacheRead;
		cacheWriteTokens += usage.cacheWrite;
		costUsd += usage.cost.total;
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		lastTurnTokens = promptTokens + usage.output;
		lastCostUsd = usage.cost.total;
		latestHitRate = promptTokens > 0 ? usage.cacheRead / promptTokens * 100 : undefined;
	}
	const totalPromptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
	const totalObservedTokens = totalPromptTokens + outputTokens;
	return {
		usage: {
			inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalObservedTokens,
			...(lastTurnTokens === undefined ? {} : { lastTurnTokens }),
			...(assistantTurns > 0 ? { averageTokensPerAssistantTurn: totalObservedTokens / assistantTurns } : {}),
			...(costUsd > 0 ? { costUsd } : {}),
			...(lastCostUsd !== undefined && lastCostUsd > 0 ? { lastCostUsd } : {}),
		},
		cache: {
			...(latestHitRate === undefined ? {} : { latestHitRate }),
			...(totalPromptTokens > 0 ? { totalHitRate: cacheReadTokens / totalPromptTokens * 100 } : {}),
			...(cacheWriteTokens > 0 ? { readWriteRatio: cacheReadTokens / cacheWriteTokens } : {}),
		},
	};
}
