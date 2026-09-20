import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CacheStats, UsageStats } from "./types.ts";

/** 对话轮次和命中率只统计 assistant，不包含后台请求。 */
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

/** 会话总量额外计入保温、摘要和工具用量，不改变对话指标。 */
export function summarizeSessionUsage(entries: readonly SessionEntry[]): { usage: UsageStats; cache: CacheStats } {
	const messages: AgentMessage[] = [];
	const additional: Usage[] = [];
	const cacheWarming = { requests: 0, tokens: 0, costUsd: 0 };
	for (const entry of entries) {
		if (entry.type === "message") {
			messages.push(entry.message);
			if (entry.message.role === "toolResult" && entry.message.usage) additional.push(entry.message.usage);
		} else if (entry.type === "usage") {
			additional.push(entry.usage);
			if (entry.kind === "cache_warm") {
				cacheWarming.requests += 1;
				cacheWarming.tokens += entry.usage.input + entry.usage.output + entry.usage.cacheRead + entry.usage.cacheWrite;
				cacheWarming.costUsd += entry.usage.cost.total;
			}
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			additional.push(entry.usage);
		}
	}
	const result = summarizeUsage(messages);
	for (const usage of additional) {
		result.usage.inputTokens += usage.input;
		result.usage.outputTokens += usage.output;
		result.usage.cacheReadTokens += usage.cacheRead;
		result.usage.cacheWriteTokens += usage.cacheWrite;
		result.usage.totalObservedTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		if (usage.cost.total > 0) result.usage.costUsd = (result.usage.costUsd ?? 0) + usage.cost.total;
	}
	if (cacheWarming.requests > 0) result.usage.cacheWarming = cacheWarming;
	return result;
}
