import type { BuildSystemPromptOptions, ExtensionCommandContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { buildContextBreakdown } from "./context-breakdown.js";
import type { CacheStats, StatsSnapshot, ToolStats, UsageStats } from "./types.js";

export interface StatsPiApi {
	getAllTools(): ToolInfo[];
	getActiveTools(): string[];
	getThinkingLevel(): string;
}

/** 从 Pi 公开 API 读取当前会话统计，不写 session entry。 */
export async function collectStatsSnapshot(ctx: ExtensionCommandContext, pi: StatsPiApi): Promise<StatsSnapshot> {
	const entries = ctx.sessionManager.getEntries();
	const branchEntries = ctx.sessionManager.getBranch();
	const messages = entries.map((entry) => (entry.type === "message" ? entry.message : undefined)).filter((message): message is Message => message !== undefined);
	const usage = collectUsage(messages);
	const activeTools = pi.getActiveTools();
	const allTools = pi.getAllTools();
	const model = ctx.model;
	const contextUsage = ctx.getContextUsage();
	const systemPromptOptions = getSystemPromptOptions(ctx);

	return {
		session: {
			cwd: ctx.cwd,
			...(model?.id !== undefined ? { modelId: model.id } : {}),
			...(model?.provider !== undefined ? { modelProvider: model.provider } : {}),
			...(model?.reasoning !== undefined ? { modelReasoning: model.reasoning } : {}),
			thinkingLevel: pi.getThinkingLevel(),
			...(model !== undefined ? { usingSubscription: ctx.modelRegistry.isUsingOAuth(model) } : {}),
			status: ctx.isIdle() ? "ready" : "running",
			userTurns: entries.filter((entry) => entry.type === "message" && entry.message.role === "user").length,
			assistantTurns: entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length,
		},
		usage,
		cache: collectCache(messages, usage),
		context: await buildContextBreakdown({
			usage: contextUsage,
			systemPrompt: ctx.getSystemPrompt(),
			activeTools,
			allTools,
			branchEntries,
			tokenCounter: {
				...(model?.provider !== undefined ? { provider: model.provider } : {}),
				...(model?.id !== undefined ? { modelId: model.id } : {}),
				...(model?.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}),
			},
			...(systemPromptOptions !== undefined ? { systemPromptOptions } : {}),
		}),
		tools: collectTools(messages, activeTools.length, allTools.length),
		generatedAt: new Date(),
	};
}

function getSystemPromptOptions(ctx: ExtensionCommandContext): BuildSystemPromptOptions | undefined {
	try {
		return ctx.getSystemPromptOptions();
	} catch {
		return undefined;
	}
}

export function collectUsage(messages: Message[]): UsageStats {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let costUsd = 0;
	let lastTurnTokens: number | undefined;
	let lastCostUsd: number | undefined;
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
		lastTurnTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		lastCostUsd = usage.cost.total;
	}

	const totalObservedTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalObservedTokens,
		...(lastTurnTokens !== undefined ? { lastTurnTokens } : {}),
		...(assistantTurns > 0 ? { averageTokensPerAssistantTurn: totalObservedTokens / assistantTurns } : {}),
		...(costUsd > 0 ? { costUsd } : {}),
		...(lastCostUsd !== undefined && lastCostUsd > 0 ? { lastCostUsd } : {}),
	};
}

export function collectCache(messages: Message[], usage: UsageStats): CacheStats {
	let latestHitRate: number | undefined;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const promptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		latestHitRate = promptTokens > 0 ? (message.usage.cacheRead / promptTokens) * 100 : undefined;
	}

	const totalPromptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
	return {
		...(latestHitRate !== undefined ? { latestHitRate } : {}),
		...(totalPromptTokens > 0 ? { totalHitRate: (usage.cacheReadTokens / totalPromptTokens) * 100 } : {}),
		...(usage.cacheWriteTokens > 0 ? { readWriteRatio: usage.cacheReadTokens / usage.cacheWriteTokens } : {}),
	};
}

export function collectTools(messages: Message[], activeCount: number | undefined, totalCount: number | undefined): ToolStats {
	const byName = new Map<string, { calls: number; failures: number; outputChars: number }>();
	let calls = 0;
	let successes = 0;
	let failures = 0;

	for (const message of messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				calls += 1;
				const stats = ensureToolStats(byName, part.name);
				stats.calls += 1;
			}
		} else if (message.role === "toolResult") {
			const stats = ensureToolStats(byName, message.toolName);
			stats.outputChars += countContentChars(message.content);
			if (message.isError) {
				failures += 1;
				stats.failures += 1;
			} else successes += 1;
		}
	}

	return {
		...(activeCount !== undefined ? { activeCount } : {}),
		...(totalCount !== undefined ? { totalCount } : {}),
		calls,
		...(successes + failures > 0 ? { successes, failures } : {}),
		byName: [...byName.entries()]
			.map(([name, value]) => ({
				name,
				calls: value.calls,
				...(value.failures > 0 ? { failures: value.failures } : {}),
				...(value.outputChars > 0 ? { outputChars: value.outputChars } : {}),
			}))
			.sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name)),
	};
}

function ensureToolStats(map: Map<string, { calls: number; failures: number; outputChars: number }>, name: string): { calls: number; failures: number; outputChars: number } {
	const existing = map.get(name);
	if (existing !== undefined) return existing;
	const created = { calls: 0, failures: 0, outputChars: 0 };
	map.set(name, created);
	return created;
}

function countContentChars(content: ToolResultMessage["content"]): number {
	return content.reduce((total, part) => total + (part.type === "text" ? [...part.text].length : part.data.length), 0);
}
