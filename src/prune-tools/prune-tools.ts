import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, ModelCostRates, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";

import { countTextTokensSync, type TokenCounterConfidence, type TokenCounterScope } from "../token-counter.js";

export const PRUNE_TOOLS_STATE = "prune-tools";
export const PRUNE_TOOLS_STATE_VERSION = 2;
export const COST_CLOSE_RATIO = 0.1;

const IMAGE_TOKEN_ESTIMATE = 1200;
const TOKENS_PER_MILLION = 1_000_000;

export interface PruneToolsPruneState {
	version: typeof PRUNE_TOOLS_STATE_VERSION;
	operation: "prune";
	toolCallIds: string[];
	previousToolCallIds: string[];
}

export interface PruneToolsRestoreState {
	version: typeof PRUNE_TOOLS_STATE_VERSION;
	operation: "restore";
	toolCallIds: string[];
	restoredEntryId: string;
}

export type PruneToolsState = PruneToolsPruneState | PruneToolsRestoreState;

export interface RestorablePruneToolsState extends PruneToolsPruneState {
	entryId: string;
}

export interface PruneResult {
	messages: AgentMessage[];
	removedAssistantMessages: number;
	removedToolCalls: number;
	removedToolResults: number;
}

export interface PruneTokenEstimate {
	tokens: number;
	confidence: TokenCounterConfidence;
}

export interface PruneCostPreview {
	fullTokens: number;
	prunedTokens: number;
	commonPrefixTokens: number;
	keepCostUsd: number;
	pruneCostUsd: number;
	closeRatio: number;
	tokenConfidence: TokenCounterConfidence;
	shouldPrune: boolean;
	missPricing: "input" | "cache_write";
}

export interface PruneCostInput {
	model: Model<Api>;
	fullTokens: number;
	prunedTokens: number;
	commonPrefixTokens: number;
	cacheableFullTokens: number;
	usesCacheWrite: boolean;
	tokenConfidence?: TokenCounterConfidence;
}

export function findCompletedToolCallIds(messages: readonly AgentMessage[], excluded: ReadonlySet<string> = new Set()): Set<string> {
	const resultIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && !excluded.has(message.toolCallId)) resultIds.add(message.toolCallId);
	}

	const completed = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && resultIds.has(block.id) && !excluded.has(block.id)) completed.add(block.id);
		}
	}
	return completed;
}

export function pruneToolTransactions(messages: readonly AgentMessage[], toolCallIds: ReadonlySet<string>): PruneResult {
	const pruned: AgentMessage[] = [];
	let removedAssistantMessages = 0;
	let removedToolCalls = 0;
	let removedToolResults = 0;

	for (const message of messages) {
		if (message.role === "toolResult" && toolCallIds.has(message.toolCallId)) {
			removedToolResults += 1;
			continue;
		}
		if (message.role !== "assistant") {
			pruned.push(message);
			continue;
		}

		const removedCalls = message.content.filter((block) => block.type === "toolCall" && toolCallIds.has(block.id));
		if (removedCalls.length === 0) {
			pruned.push(message);
			continue;
		}

		removedToolCalls += removedCalls.length;
		const hasRemainingToolCall = message.content.some((block) => block.type === "toolCall" && !toolCallIds.has(block.id));
		const content = message.content.filter((block) => {
			if (block.type === "toolCall") return !toolCallIds.has(block.id);
			if (block.type === "thinking") return hasRemainingToolCall;
			return true;
		});
		if (content.length === 0) {
			removedAssistantMessages += 1;
			continue;
		}
		pruned.push({ ...message, content });
	}

	return {
		messages: pruned,
		removedAssistantMessages,
		removedToolCalls,
		removedToolResults,
	};
}

export function readPruneToolsState(entries: readonly SessionEntry[]): PruneToolsState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== PRUNE_TOOLS_STATE) continue;
		const state = parsePruneToolsState(entry.data);
		if (state) return state;
	}
	return undefined;
}

export function findRestorablePruneToolsState(entries: readonly SessionEntry[]): RestorablePruneToolsState | undefined {
	const prunes = new Map<string, RestorablePruneToolsState>();
	const restored = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PRUNE_TOOLS_STATE) continue;
		const state = parsePruneToolsState(entry.data);
		if (!state) continue;
		if (state.operation === "prune") {
			prunes.set(entry.id, { ...state, entryId: entry.id });
			continue;
		}
		if (prunes.has(state.restoredEntryId)) restored.add(state.restoredEntryId);
	}

	const candidates = [...prunes.values()];
	for (let index = candidates.length - 1; index >= 0; index--) {
		const candidate = candidates[index];
		if (candidate && !restored.has(candidate.entryId)) return candidate;
	}
	return undefined;
}

export function estimateMessagesTokens(messages: readonly AgentMessage[], scope: TokenCounterScope): number {
	return estimateMessagesTokensWithConfidence(messages, scope).tokens;
}

export function estimateMessagesTokensWithConfidence(
	messages: readonly AgentMessage[],
	scope: TokenCounterScope,
): PruneTokenEstimate {
	return messages.reduce(
		(total, message) => combineEstimates(total, estimateMessageTokensWithConfidence(message, scope)),
		emptyEstimate(),
	);
}

export function estimateStaticPrefixTokens(
	systemPrompt: string,
	activeToolNames: readonly string[],
	allTools: readonly ToolInfo[],
	scope: TokenCounterScope,
): number {
	return estimateStaticPrefixTokensWithConfidence(systemPrompt, activeToolNames, allTools, scope).tokens;
}

export function estimateStaticPrefixTokensWithConfidence(
	systemPrompt: string,
	activeToolNames: readonly string[],
	allTools: readonly ToolInfo[],
	scope: TokenCounterScope,
): PruneTokenEstimate {
	const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
	const definitions = activeToolNames
		.map((name) => toolsByName.get(name))
		.filter((tool): tool is ToolInfo => tool !== undefined)
		.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
	return combineEstimates(
		countTextWithConfidence(systemPrompt, scope),
		countTextWithConfidence(JSON.stringify(definitions), scope),
	);
}

export function findCommonPrefixTokens(
	messages: readonly AgentMessage[],
	toolCallIds: ReadonlySet<string>,
	staticPrefixTokens: number,
	scope: TokenCounterScope,
): number {
	let tokens = staticPrefixTokens;
	for (const message of messages) {
		if (messageChanges(message, toolCallIds)) break;
		tokens += estimateMessageTokens(message, scope);
	}
	return tokens;
}

export function getUsageContextTokens(usage: Usage): number {
	return usage.totalTokens > 0
		? usage.totalTokens
		: usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export function getLastUsage(messages: readonly AgentMessage[]): Usage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const usage = message.usage;
		if (message.stopReason !== "aborted" && message.stopReason !== "error" && getUsageContextTokens(usage) > 0) return usage;
	}
	return undefined;
}

export function hasObservedCacheWrite(messages: readonly AgentMessage[]): boolean {
	return messages.some((message) => message.role === "assistant" && message.usage.cacheWrite > 0);
}

export function buildPruneCostPreview(input: PruneCostInput): PruneCostPreview {
	const fullTokens = finiteTokens(input.fullTokens);
	const prunedTokens = Math.min(fullTokens, finiteTokens(input.prunedTokens));
	const fullRates = selectRates(input.model, fullTokens);
	const prunedRates = selectRates(input.model, prunedTokens);
	const cacheableFullTokens = Math.min(fullTokens, finiteTokens(input.cacheableFullTokens));
	const commonPrefixTokens = Math.min(prunedTokens, cacheableFullTokens, finiteTokens(input.commonPrefixTokens));
	const missPricing = input.usesCacheWrite ? "cache_write" : "input";
	const fullMissRate = input.usesCacheWrite ? fullRates.cacheWrite : fullRates.input;
	const prunedMissRate = input.usesCacheWrite ? prunedRates.cacheWrite : prunedRates.input;
	const keepCostUsd = tokenCost(cacheableFullTokens, fullRates.cacheRead)
		+ tokenCost(fullTokens - cacheableFullTokens, fullMissRate);
	const pruneCostUsd = tokenCost(commonPrefixTokens, prunedRates.cacheRead)
		+ tokenCost(prunedTokens - commonPrefixTokens, prunedMissRate);
	const tokenConfidence = input.tokenConfidence ?? "high";
	const closeRatio = tokenConfidence === "low" ? 0 : COST_CLOSE_RATIO;
	const shouldPrune = tokenConfidence === "low"
		? pruneCostUsd < keepCostUsd
		: keepCostUsd === 0
			? pruneCostUsd === 0
			: pruneCostUsd <= keepCostUsd * (1 + closeRatio);

	return {
		fullTokens,
		prunedTokens,
		commonPrefixTokens,
		keepCostUsd,
		pruneCostUsd,
		closeRatio,
		tokenConfidence,
		shouldPrune,
		missPricing,
	};
}

function parsePruneToolsState(value: unknown): PruneToolsState | undefined {
	if (!isRecord(value)) return undefined;
	const toolCallIds = parseStringArray(value.toolCallIds);
	if (!toolCallIds) return undefined;
	if (value.version === 1) {
		return {
			version: PRUNE_TOOLS_STATE_VERSION,
			operation: "prune",
			toolCallIds,
			previousToolCallIds: [],
		};
	}
	if (value.version !== PRUNE_TOOLS_STATE_VERSION) return undefined;
	if (value.operation === "prune") {
		const previousToolCallIds = parseStringArray(value.previousToolCallIds);
		if (!previousToolCallIds) return undefined;
		return {
			version: PRUNE_TOOLS_STATE_VERSION,
			operation: "prune",
			toolCallIds,
			previousToolCallIds,
		};
	}
	if (value.operation !== "restore" || typeof value.restoredEntryId !== "string") return undefined;
	return {
		version: PRUNE_TOOLS_STATE_VERSION,
		operation: "restore",
		toolCallIds,
		restoredEntryId: value.restoredEntryId,
	};
}

function parseStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
	return [...new Set(value)];
}

function messageChanges(message: AgentMessage, toolCallIds: ReadonlySet<string>): boolean {
	if (message.role === "toolResult") return toolCallIds.has(message.toolCallId);
	return message.role === "assistant"
		&& message.content.some((block) => block.type === "toolCall" && toolCallIds.has(block.id));
}

function estimateMessageTokens(message: AgentMessage, scope: TokenCounterScope): number {
	return estimateMessageTokensWithConfidence(message, scope).tokens;
}

function estimateMessageTokensWithConfidence(message: AgentMessage, scope: TokenCounterScope): PruneTokenEstimate {
	switch (message.role) {
		case "user":
			return estimateContentTokensWithConfidence(message.content, scope);
		case "assistant":
			return message.content.reduce((total, block) => {
				if (block.type === "text") return combineEstimates(total, countTextWithConfidence(block.text, scope));
				if (block.type === "thinking") return combineEstimates(total, countTextWithConfidence(block.thinking, scope));
				return combineEstimates(total, countTextWithConfidence(`${block.name} ${JSON.stringify(block.arguments)}`, scope));
			}, emptyEstimate());
		case "toolResult":
			return combineEstimates(
				countTextWithConfidence(message.toolName, scope),
				estimateContentTokensWithConfidence(message.content, scope),
			);
		case "custom":
			return estimateContentTokensWithConfidence(message.content, scope);
		case "branchSummary":
		case "compactionSummary":
			return countTextWithConfidence(message.summary, scope);
		case "bashExecution":
			return countTextWithConfidence(`${message.command}\n${message.output}`, scope);
	}
}

function estimateContentTokensWithConfidence(
	content: string | ReadonlyArray<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
	scope: TokenCounterScope,
): PruneTokenEstimate {
	if (typeof content === "string") return countTextWithConfidence(content, scope);
	return content.reduce((total, block) => combineEstimates(
		total,
		block.type === "text"
			? countTextWithConfidence(block.text, scope)
			: { tokens: IMAGE_TOKEN_ESTIMATE, confidence: "low" },
	), emptyEstimate());
}

function countTextWithConfidence(text: string, scope: TokenCounterScope): PruneTokenEstimate {
	if (text.trim().length === 0) return emptyEstimate();
	const counted = countTextTokensSync(text, scope);
	return { tokens: counted.tokens, confidence: counted.confidence };
}

function emptyEstimate(): PruneTokenEstimate {
	return { tokens: 0, confidence: "high" };
}

function combineEstimates(left: PruneTokenEstimate, right: PruneTokenEstimate): PruneTokenEstimate {
	return {
		tokens: left.tokens + right.tokens,
		confidence: lowerConfidence(left.confidence, right.confidence),
	};
}

function lowerConfidence(left: TokenCounterConfidence, right: TokenCounterConfidence): TokenCounterConfidence {
	const rank: Record<TokenCounterConfidence, number> = { exact: 4, high: 3, medium: 2, low: 1 };
	return rank[left] <= rank[right] ? left : right;
}

function selectRates(model: Model<Api>, inputTokens: number): ModelCostRates {
	let rates: ModelCostRates = model.cost;
	let threshold = -1;
	for (const tier of model.cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
			rates = tier;
			threshold = tier.inputTokensAbove;
		}
	}
	return rates;
}

function tokenCost(tokens: number, rate: number): number {
	return (tokens * rate) / TOKENS_PER_MILLION;
}

function finiteTokens(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
