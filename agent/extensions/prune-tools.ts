import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
	buildPruneCostPreview,
	estimateMessagesTokensWithConfidence,
	estimateStaticPrefixTokensWithConfidence,
	findCommonPrefixTokens,
	findCompletedToolCallIds,
	findRestorablePruneToolsState,
	getLastUsage,
	getUsageContextTokens,
	hasObservedCacheWrite,
	PRUNE_TOOLS_STATE,
	PRUNE_TOOLS_STATE_VERSION,
	pruneToolTransactions,
	readPruneToolsState,
	type PruneCostPreview,
	type PruneToolsPruneState,
	type PruneToolsRestoreState,
} from "../../src/prune-tools/prune-tools.js";

const COMMAND_NAME = "prune-tools";
const COMMAND_DESCRIPTION = "Remove stale tool transactions from context.";
const COMMAND_OPERATIONS = ["force", "restore"] as const;

type PruneToolsApi = Pick<ExtensionAPI, "appendEntry" | "getActiveTools" | "getAllTools" | "on" | "registerCommand">;
export type PruneToolsCommandApi = Pick<PruneToolsApi, "appendEntry" | "getActiveTools" | "getAllTools">;

export interface PruneToolsCommandContext {
	model: Model<Api> | undefined;
	sessionManager: Pick<ExtensionCommandContext["sessionManager"], "buildContextEntries" | "getBranch">;
	ui: Pick<ExtensionCommandContext["ui"], "notify">;
	waitForIdle(): Promise<void>;
	getContextUsage(): ReturnType<ExtensionCommandContext["getContextUsage"]>;
	getSystemPrompt(): string;
}

export default function pruneToolsExtension(pi: PruneToolsApi): void {
	pi.on("context", (event, ctx) => {
		const messages = applyPersistedToolPruning(event.messages, ctx.sessionManager.getBranch());
		if (messages === event.messages) return;
		return { messages };
	});

	pi.registerCommand(COMMAND_NAME, {
		description: COMMAND_DESCRIPTION,
		getArgumentCompletions: (argumentPrefix) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			const completions = COMMAND_OPERATIONS
				.filter((operation) => operation.startsWith(prefix))
				.map((operation) => ({ label: operation, value: operation }));
			return completions.length > 0 ? completions : null;
		},
		async handler(args, ctx) {
			await runPruneToolsCommandArgs(pi, ctx, args);
		},
	});
}

export function applyPersistedToolPruning(
	messages: AgentMessage[],
	branchEntries: Parameters<typeof readPruneToolsState>[0],
): AgentMessage[] {
	const state = readPruneToolsState(branchEntries);
	if (!state) return messages;
	return pruneToolTransactions(messages, new Set(state.toolCallIds)).messages;
}

export async function runPruneToolsCommandArgs(
	pi: PruneToolsCommandApi,
	ctx: PruneToolsCommandContext,
	args: string,
): Promise<void> {
	const operation = args.trim().toLowerCase();
	if (operation === "force") {
		await runForcePruneToolsCommand(pi, ctx);
		return;
	}
	if (operation === "restore") {
		await runRestorePruneToolsCommand(pi, ctx);
		return;
	}
	if (operation.length > 0) {
		ctx.ui.notify("usage: /prune-tools [force|restore]", "error");
		return;
	}
	await runPruneToolsCommand(pi, ctx);
}

export async function runPruneToolsCommand(pi: PruneToolsCommandApi, ctx: PruneToolsCommandContext): Promise<void> {
	await ctx.waitForIdle();
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify("/prune-tools requires an active model", "error");
		return;
	}

	const selection = selectPrunableToolTransactions(ctx);
	if (selection.candidates.size === 0) {
		ctx.ui.notify("No completed tool transactions to prune.", "info");
		return;
	}

	const preview = previewPruneCost(
		ctx,
		pi,
		model,
		selection.beforeMessages,
		selection.afterResult.messages,
		selection.rawMessages,
		selection.candidates,
	);
	if (!preview.shouldPrune) {
		ctx.ui.notify(formatRetained(preview, selection.candidates.size), "info");
		return;
	}

	appendPruneState(pi, selection.previouslyPruned, selection.candidates);
	ctx.ui.notify(formatPruned(preview, selection.afterResult), "info");
}

export async function runForcePruneToolsCommand(
	pi: Pick<PruneToolsCommandApi, "appendEntry">,
	ctx: Pick<PruneToolsCommandContext, "sessionManager" | "ui" | "waitForIdle">,
): Promise<void> {
	await ctx.waitForIdle();
	const selection = selectPrunableToolTransactions(ctx);
	if (selection.candidates.size === 0) {
		ctx.ui.notify("No completed tool transactions to prune.", "info");
		return;
	}

	appendPruneState(pi, selection.previouslyPruned, selection.candidates);
	ctx.ui.notify(formatForcePruned(selection.afterResult), "info");
}

export async function runRestorePruneToolsCommand(
	pi: Pick<PruneToolsCommandApi, "appendEntry">,
	ctx: Pick<PruneToolsCommandContext, "sessionManager" | "ui" | "waitForIdle">,
): Promise<void> {
	await ctx.waitForIdle();
	const target = findRestorablePruneToolsState(ctx.sessionManager.getBranch());
	if (!target) {
		ctx.ui.notify("No /prune-tools change to restore.", "info");
		return;
	}

	const previousToolCallIds = new Set(target.previousToolCallIds);
	const restoredToolCallIds = target.toolCallIds.filter((id) => !previousToolCallIds.has(id));
	const currentMessages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
	const completedToolCallIds = findCompletedToolCallIds(currentMessages);
	if (restoredToolCallIds.some((id) => !completedToolCallIds.has(id))) {
		ctx.ui.notify(
			"Cannot restore the most recent /prune-tools change: compaction removed one or more tool transactions. No restore state was written.",
			"error",
		);
		return;
	}

	const state: PruneToolsRestoreState = {
		version: PRUNE_TOOLS_STATE_VERSION,
		operation: "restore",
		toolCallIds: target.previousToolCallIds,
		restoredEntryId: target.entryId,
	};
	pi.appendEntry(PRUNE_TOOLS_STATE, state);
	ctx.ui.notify(
		`Restored the most recent /prune-tools change: ${restoredToolCallIds.length} tool calls returned to context.`,
		"info",
	);
}

interface PrunableToolTransactions {
	rawMessages: AgentMessage[];
	beforeMessages: AgentMessage[];
	afterResult: ReturnType<typeof pruneToolTransactions>;
	previouslyPruned: Set<string>;
	candidates: Set<string>;
}

function selectPrunableToolTransactions(
	ctx: Pick<PruneToolsCommandContext, "sessionManager">,
): PrunableToolTransactions {
	const rawMessages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
	const previousState = readPruneToolsState(ctx.sessionManager.getBranch());
	const previouslyPruned = new Set(previousState?.toolCallIds ?? []);
	const beforeMessages = pruneToolTransactions(rawMessages, previouslyPruned).messages;
	const candidates = findCompletedToolCallIds(beforeMessages);
	return {
		rawMessages,
		beforeMessages,
		afterResult: pruneToolTransactions(beforeMessages, candidates),
		previouslyPruned,
		candidates,
	};
}

function appendPruneState(
	pi: Pick<PruneToolsCommandApi, "appendEntry">,
	previouslyPruned: ReadonlySet<string>,
	candidates: ReadonlySet<string>,
): void {
	const state: PruneToolsPruneState = {
		version: PRUNE_TOOLS_STATE_VERSION,
		operation: "prune",
		toolCallIds: [...new Set([...previouslyPruned, ...candidates])].sort(),
		previousToolCallIds: [...previouslyPruned].sort(),
	};
	pi.appendEntry(PRUNE_TOOLS_STATE, state);
}

function previewPruneCost(
	ctx: PruneToolsCommandContext,
	pi: Pick<PruneToolsCommandApi, "getActiveTools" | "getAllTools">,
	model: Model<Api>,
	beforeMessages: readonly AgentMessage[],
	afterMessages: readonly AgentMessage[],
	cacheEvidenceMessages: readonly AgentMessage[],
	candidates: ReadonlySet<string>,
): PruneCostPreview {
	const scope = { provider: model.provider, modelId: model.id, baseUrl: model.baseUrl };
	const allTools = pi.getAllTools();
	const staticPrefix = estimateStaticPrefixTokensWithConfidence(ctx.getSystemPrompt(), pi.getActiveTools(), allTools, scope);
	const beforeEstimate = estimateMessagesTokensWithConfidence(beforeMessages, scope);
	const afterEstimate = estimateMessagesTokensWithConfidence(afterMessages, scope);
	const staticPrefixTokens = staticPrefix.tokens;
	const beforeEstimated = staticPrefixTokens + beforeEstimate.tokens;
	const afterEstimated = staticPrefixTokens + afterEstimate.tokens;
	const tokenConfidence = staticPrefix.confidence === "low"
		|| beforeEstimate.confidence === "low"
		|| afterEstimate.confidence === "low"
		? "low"
		: "high";
	// Context usage can describe the unfiltered session. Compare two estimates of the effective prompt instead.
	const fullTokens = beforeEstimated;
	const prunedTokens = afterEstimated;
	const lastUsage = getLastUsage(beforeMessages);
	const cacheableFullTokens = lastUsage && getUsageContextTokens(lastUsage) > 0
		? lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite
		: 0;
	const commonPrefixTokens = findCommonPrefixTokens(beforeMessages, candidates, staticPrefixTokens, scope);
	return buildPruneCostPreview({
		model,
		fullTokens,
		prunedTokens,
		commonPrefixTokens,
		cacheableFullTokens,
		usesCacheWrite: hasObservedCacheWrite(cacheEvidenceMessages),
		tokenConfidence,
	});
}

function formatPruned(
	preview: PruneCostPreview,
	result: ReturnType<typeof pruneToolTransactions>,
): string {
	return [
		`Pruned ${result.removedToolCalls} calls, ${result.removedToolResults} outputs, ${result.removedAssistantMessages} tool-only assistant messages.`,
		`Next prompt: ${formatTokens(preview.fullTokens)} -> ${formatTokens(preview.prunedTokens)} tokens; ${formatUsd(preview.keepCostUsd)} keep vs ${formatUsd(preview.pruneCostUsd)} pruned.`
	].join("\n");
}

function formatForcePruned(result: ReturnType<typeof pruneToolTransactions>): string {
	return [
		`Force-pruned ${result.removedToolCalls} calls, ${result.removedToolResults} outputs, ${result.removedAssistantMessages} tool-only assistant messages.`,
		"Cost calculation was skipped.",
	].join("\n");
}

function formatRetained(preview: PruneCostPreview, calls: number): string {
	return [
		`Kept context: pruning ${calls} completed calls would cost more on the next prompt.`,
		`${formatTokens(preview.fullTokens)} -> ${formatTokens(preview.prunedTokens)} tokens; ${formatUsd(preview.keepCostUsd)} keep vs ${formatUsd(preview.pruneCostUsd)} pruned.`,
	].join("\n");
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

function formatUsd(value: number): string {
	return `$${value.toFixed(value < 0.01 ? 4 : 3)}`;
}
