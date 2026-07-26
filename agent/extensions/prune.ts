import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
	applyPersistedToolPruning,
	buildPruneCostPreview,
	estimateMessagesTokensWithConfidence,
	estimateStaticPrefixTokensWithConfidence,
	findCommonPrefixTokens,
	findCompletedToolCallIds,
	findRestorablePruneState,
	getLastUsage,
	getUsageContextTokens,
	hasObservedCacheWrite,
	PRUNE_STATE,
	parsePruneState,
	pruneToolTransactions,
	readPruneState,
	type PruneCostPreview,
	type PruneCheckpointState,
	type PruneRestoreState,
} from "../../src/prune/prune.js";
import { PruneSummaryComponent } from "../../src/prune/renderer.js";
import { resetPruneTuiState, syncPruneTuiState } from "../../src/prune/tui-state.js";

export { applyPersistedToolPruning } from "../../src/prune/prune.js";

const COMMAND_NAME = "prune";
const COMMAND_DESCRIPTION = "Remove stale tool transactions from context.";
const COMMAND_OPERATIONS = ["force", "restore"] as const;

type PruneApi = Pick<
	ExtensionAPI,
	"appendEntry" | "getActiveTools" | "getAllTools" | "on" | "registerCommand" | "registerEntryRenderer"
>;
export type PruneCommandApi = Pick<PruneApi, "appendEntry" | "getActiveTools" | "getAllTools">;

export interface PruneCommandContext {
	mode: ExtensionCommandContext["mode"];
	model: Model<Api> | undefined;
	sessionManager: Pick<ExtensionCommandContext["sessionManager"], "buildContextEntries" | "getBranch">;
	ui: Pick<ExtensionCommandContext["ui"], "notify">;
	waitForIdle(): Promise<void>;
	getContextUsage(): ReturnType<ExtensionCommandContext["getContextUsage"]>;
	getSystemPrompt(): string;
}

export default function pruneExtension(pi: PruneApi): void {
	pi.registerEntryRenderer(PRUNE_STATE, (entry, _options, theme) => {
		if (!parsePruneState(entry.data)) return undefined;
		return new PruneSummaryComponent(entry.id, theme);
	});

	pi.on("session_start", (_event, ctx) => {
		syncPruneTuiForContext(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		syncPruneTuiForContext(ctx);
	});
	pi.on("session_shutdown", () => {
		resetPruneTuiState();
	});

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
			await runPruneCommandArgs(pi, ctx, args);
		},
	});
}

export async function runPruneCommandArgs(
	pi: PruneCommandApi,
	ctx: PruneCommandContext,
	args: string,
): Promise<void> {
	const operation = args.trim().toLowerCase();
	if (operation === "force") {
		await runForcePruneCommand(pi, ctx);
		return;
	}
	if (operation === "restore") {
		await runRestorePruneCommand(pi, ctx);
		return;
	}
	if (operation.length > 0) {
		ctx.ui.notify("usage: /prune [force|restore]", "error");
		return;
	}
	await runPruneCommand(pi, ctx);
}

export async function runPruneCommand(pi: PruneCommandApi, ctx: PruneCommandContext): Promise<void> {
	await ctx.waitForIdle();
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify("/prune requires an active model", "error");
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
	syncPruneTuiForContext(ctx);
	ctx.ui.notify(formatPruned(preview, selection.afterResult), "info");
}

export async function runForcePruneCommand(
	pi: Pick<PruneCommandApi, "appendEntry">,
	ctx: Pick<PruneCommandContext, "mode" | "sessionManager" | "ui" | "waitForIdle">,
): Promise<void> {
	await ctx.waitForIdle();
	const selection = selectPrunableToolTransactions(ctx);
	if (selection.candidates.size === 0) {
		ctx.ui.notify("No completed tool transactions to prune.", "info");
		return;
	}

	appendPruneState(pi, selection.previouslyPruned, selection.candidates);
	syncPruneTuiForContext(ctx);
	ctx.ui.notify(formatForcePruned(selection.afterResult), "info");
}

export async function runRestorePruneCommand(
	pi: Pick<PruneCommandApi, "appendEntry">,
	ctx: Pick<PruneCommandContext, "mode" | "sessionManager" | "ui" | "waitForIdle">,
): Promise<void> {
	await ctx.waitForIdle();
	const target = findRestorablePruneState(ctx.sessionManager.getBranch());
	if (!target) {
		ctx.ui.notify("No /prune change to restore.", "info");
		return;
	}

	const previousToolCallIds = new Set(target.previousToolCallIds);
	const restoredToolCallIds = target.toolCallIds.filter((id) => !previousToolCallIds.has(id));
	const currentMessages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
	const completedToolCallIds = findCompletedToolCallIds(currentMessages);
	if (restoredToolCallIds.some((id) => !completedToolCallIds.has(id))) {
		ctx.ui.notify(
			"Cannot restore the most recent /prune change: compaction removed one or more tool transactions. No restore state was written.",
			"error",
		);
		return;
	}

	const state: PruneRestoreState = {
		operation: "restore",
		toolCallIds: target.previousToolCallIds,
		restoredEntryId: target.entryId,
	};
	pi.appendEntry(PRUNE_STATE, state);
	syncPruneTuiForContext(ctx);
	ctx.ui.notify(
		`Restored the most recent /prune change: ${restoredToolCallIds.length} tool calls returned to context.`,
		"info",
	);
}

function syncPruneTuiForContext(
	ctx: Pick<PruneCommandContext, "mode" | "sessionManager">,
): void {
	if (ctx.mode !== "tui") return;
	syncPruneTuiState(ctx.sessionManager.getBranch());
}

interface PrunableToolTransactions {
	rawMessages: AgentMessage[];
	beforeMessages: AgentMessage[];
	afterResult: ReturnType<typeof pruneToolTransactions>;
	previouslyPruned: Set<string>;
	candidates: Set<string>;
}

function selectPrunableToolTransactions(
	ctx: Pick<PruneCommandContext, "sessionManager">,
): PrunableToolTransactions {
	const rawMessages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
	const previousState = readPruneState(ctx.sessionManager.getBranch());
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
	pi: Pick<PruneCommandApi, "appendEntry">,
	previouslyPruned: ReadonlySet<string>,
	candidates: ReadonlySet<string>,
): void {
	const state: PruneCheckpointState = {
		operation: "prune",
		toolCallIds: [...new Set([...previouslyPruned, ...candidates])].sort(),
		previousToolCallIds: [...previouslyPruned].sort(),
	};
	pi.appendEntry(PRUNE_STATE, state);
}

function previewPruneCost(
	ctx: PruneCommandContext,
	pi: Pick<PruneCommandApi, "getActiveTools" | "getAllTools">,
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
