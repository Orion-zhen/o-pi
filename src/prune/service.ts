import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";

import {
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
	pruneToolTransactions,
	readPruneState,
	type PruneCheckpointState,
	type PruneCostPreview,
	type PruneRestoreState,
	type PruneState,
} from "./prune.js";

export type PruneOperation = "prune" | "force" | "restore";

export interface PruneResultSummary {
	removedAssistantMessages: number;
	removedToolCalls: number;
	removedToolResults: number;
}

export type PruneOperationOutcome =
	| {
		status: "applied";
		operation: "prune";
		code: "PRUNED";
		preview: PruneCostPreview;
		result: PruneResultSummary;
		state: PruneCheckpointState;
	}
	| {
		status: "applied";
		operation: "force";
		code: "FORCE_PRUNED";
		result: PruneResultSummary;
		state: PruneCheckpointState;
	}
	| {
		status: "applied";
		operation: "restore";
		code: "RESTORED";
		restoredToolCalls: number;
		state: PruneRestoreState;
	}
	| {
		status: "skipped";
		operation: "prune" | "force";
		code: "NO_CANDIDATES";
	}
	| {
		status: "skipped";
		operation: "prune";
		code: "RETAINED";
		candidateToolCalls: number;
		preview: PruneCostPreview;
	}
	| {
		status: "skipped";
		operation: "restore";
		code: "NO_RESTORE";
	}
	| {
		status: "rejected";
		operation: "prune";
		code: "MODEL_REQUIRED";
	}
	| {
		status: "rejected";
		operation: "restore";
		code: "RESTORE_COMPACTED";
		missingToolCallIds: string[];
	}
	| {
		status: "cancelled";
		operation: PruneOperation;
		code: "CANCELLED";
	}
	| {
		status: "failed";
		operation: PruneOperation;
		code: "IDLE_WAIT_FAILED" | "OPERATION_FAILED";
		message: string;
	};

export interface PruneServicePort {
	waitForIdle(): Promise<void>;
	getMessages(): AgentMessage[];
	getBranch(): SessionEntry[];
	appendState(customType: typeof PRUNE_STATE, state: PruneState): void;
	getActiveTools(): string[];
	getAllTools(): ToolInfo[];
	getSystemPrompt(): string;
}

export interface PruneExecutionInput {
	operation: PruneOperation;
	model: Model<Api> | undefined;
	port: PruneServicePort;
	signal?: AbortSignal;
}

/** 串行执行 prune 状态变更，避免并发命令基于同一个旧 branch 写入。 */
export class PruneService {
	private tail: Promise<void> = Promise.resolve();

	execute(input: PruneExecutionInput): Promise<PruneOperationOutcome> {
		const run = async (): Promise<PruneOperationOutcome> => {
			if (input.signal?.aborted) return cancelled(input.operation);
			try {
				await input.port.waitForIdle();
			} catch (error) {
				return failed(input.operation, "IDLE_WAIT_FAILED", error);
			}
			if (input.signal?.aborted) return cancelled(input.operation);
			try {
				return executeReady(input);
			} catch (error) {
				return failed(input.operation, "OPERATION_FAILED", error);
			}
		};
		const result = this.tail.then(run, run);
		this.tail = result.then(() => undefined, () => undefined);
		return result;
	}
}

function executeReady(input: PruneExecutionInput): PruneOperationOutcome {
	if (input.operation === "force") return forcePrune(input.port);
	if (input.operation === "restore") return restorePrune(input.port);
	if (input.model === undefined) {
		return { status: "rejected", operation: "prune", code: "MODEL_REQUIRED" };
	}
	return costAwarePrune(input.port, input.model);
}

function costAwarePrune(port: PruneServicePort, model: Model<Api>): PruneOperationOutcome {
	const selection = selectPrunableToolTransactions(port);
	if (selection.candidates.size === 0) {
		return { status: "skipped", operation: "prune", code: "NO_CANDIDATES" };
	}

	const preview = previewPruneCost(
		port,
		model,
		selection.beforeMessages,
		selection.afterResult.messages,
		selection.rawMessages,
		selection.candidates,
	);
	if (!preview.shouldPrune) {
		return {
			status: "skipped",
			operation: "prune",
			code: "RETAINED",
			candidateToolCalls: selection.candidates.size,
			preview,
		};
	}

	const state = createPruneState(selection.previouslyPruned, selection.candidates);
	port.appendState(PRUNE_STATE, state);
	return {
		status: "applied",
		operation: "prune",
		code: "PRUNED",
		preview,
		result: summarize(selection.afterResult),
		state,
	};
}

function forcePrune(port: PruneServicePort): PruneOperationOutcome {
	const selection = selectPrunableToolTransactions(port);
	if (selection.candidates.size === 0) {
		return { status: "skipped", operation: "force", code: "NO_CANDIDATES" };
	}

	const state = createPruneState(selection.previouslyPruned, selection.candidates);
	port.appendState(PRUNE_STATE, state);
	return {
		status: "applied",
		operation: "force",
		code: "FORCE_PRUNED",
		result: summarize(selection.afterResult),
		state,
	};
}

function restorePrune(port: PruneServicePort): PruneOperationOutcome {
	const target = findRestorablePruneState(port.getBranch());
	if (target === undefined) {
		return { status: "skipped", operation: "restore", code: "NO_RESTORE" };
	}

	const previousToolCallIds = new Set(target.previousToolCallIds);
	const restoredToolCallIds = target.toolCallIds.filter((id) => !previousToolCallIds.has(id));
	const completedToolCallIds = findCompletedToolCallIds(port.getMessages());
	const missingToolCallIds = restoredToolCallIds.filter((id) => !completedToolCallIds.has(id));
	if (missingToolCallIds.length > 0) {
		return {
			status: "rejected",
			operation: "restore",
			code: "RESTORE_COMPACTED",
			missingToolCallIds,
		};
	}

	const state: PruneRestoreState = {
		operation: "restore",
		toolCallIds: target.previousToolCallIds,
		restoredEntryId: target.entryId,
	};
	port.appendState(PRUNE_STATE, state);
	return {
		status: "applied",
		operation: "restore",
		code: "RESTORED",
		restoredToolCalls: restoredToolCallIds.length,
		state,
	};
}

interface PrunableToolTransactions {
	rawMessages: AgentMessage[];
	beforeMessages: AgentMessage[];
	afterResult: ReturnType<typeof pruneToolTransactions>;
	previouslyPruned: Set<string>;
	candidates: Set<string>;
}

function selectPrunableToolTransactions(port: Pick<PruneServicePort, "getBranch" | "getMessages">): PrunableToolTransactions {
	const rawMessages = port.getMessages();
	const previousState = readPruneState(port.getBranch());
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

function createPruneState(
	previouslyPruned: ReadonlySet<string>,
	candidates: ReadonlySet<string>,
): PruneCheckpointState {
	return {
		operation: "prune",
		toolCallIds: [...new Set([...previouslyPruned, ...candidates])].sort(),
		previousToolCallIds: [...previouslyPruned].sort(),
	};
}

function previewPruneCost(
	port: Pick<PruneServicePort, "getActiveTools" | "getAllTools" | "getSystemPrompt">,
	model: Model<Api>,
	beforeMessages: readonly AgentMessage[],
	afterMessages: readonly AgentMessage[],
	cacheEvidenceMessages: readonly AgentMessage[],
	candidates: ReadonlySet<string>,
): PruneCostPreview {
	const scope = { provider: model.provider, modelId: model.id, baseUrl: model.baseUrl };
	const staticPrefix = estimateStaticPrefixTokensWithConfidence(
		port.getSystemPrompt(),
		port.getActiveTools(),
		port.getAllTools(),
		scope,
	);
	const beforeEstimate = estimateMessagesTokensWithConfidence(beforeMessages, scope);
	const afterEstimate = estimateMessagesTokensWithConfidence(afterMessages, scope);
	const staticPrefixTokens = staticPrefix.tokens;
	const tokenConfidence = staticPrefix.confidence === "low"
		|| beforeEstimate.confidence === "low"
		|| afterEstimate.confidence === "low"
		? "low"
		: "high";
	const lastUsage = getLastUsage(beforeMessages);
	const cacheableFullTokens = lastUsage && getUsageContextTokens(lastUsage) > 0
		? lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite
		: 0;
	return buildPruneCostPreview({
		model,
		fullTokens: staticPrefixTokens + beforeEstimate.tokens,
		prunedTokens: staticPrefixTokens + afterEstimate.tokens,
		commonPrefixTokens: findCommonPrefixTokens(beforeMessages, candidates, staticPrefixTokens, scope),
		cacheableFullTokens,
		usesCacheWrite: hasObservedCacheWrite(cacheEvidenceMessages),
		tokenConfidence,
	});
}

function summarize(result: ReturnType<typeof pruneToolTransactions>): PruneResultSummary {
	return {
		removedAssistantMessages: result.removedAssistantMessages,
		removedToolCalls: result.removedToolCalls,
		removedToolResults: result.removedToolResults,
	};
}

function cancelled(operation: PruneOperation): PruneOperationOutcome {
	return { status: "cancelled", operation, code: "CANCELLED" };
}

function failed(
	operation: PruneOperation,
	code: "IDLE_WAIT_FAILED" | "OPERATION_FAILED",
	error: unknown,
): PruneOperationOutcome {
	return {
		status: "failed",
		operation,
		code,
		message: error instanceof Error ? error.message : String(error),
	};
}
