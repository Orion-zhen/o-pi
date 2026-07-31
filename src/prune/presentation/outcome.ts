import type { PruneOperationOutcome, PruneResultSummary } from "../service.js";
import type { PruneCostPreview } from "../prune.js";

export interface PruneNotice {
	message: string;
	type: "info" | "error";
}

/** 将结构化 prune outcome 映射为 slash command 通知。 */
export function formatPruneOutcome(outcome: PruneOperationOutcome): PruneNotice {
	if (outcome.status === "cancelled") return { message: "Prune cancelled.", type: "info" };
	if (outcome.status === "failed") return { message: `Prune failed: ${outcome.message}`, type: "error" };
	if (outcome.code === "MODEL_REQUIRED") {
		return { message: "/prune requires an active model", type: "error" };
	}
	if (outcome.code === "NO_CANDIDATES") {
		return { message: "No completed tool transactions to prune.", type: "info" };
	}
	if (outcome.code === "NO_RESTORE") {
		return { message: "No /prune change to restore.", type: "info" };
	}
	if (outcome.code === "RESTORE_COMPACTED") {
		return {
			message: "Cannot restore the most recent /prune change: compaction removed one or more tool transactions. No restore state was written.",
			type: "error",
		};
	}
	if (outcome.code === "RESTORED") {
		return {
			message: `Restored the most recent /prune change: ${outcome.restoredToolCalls} tool calls returned to context.`,
			type: "info",
		};
	}
	if (outcome.code === "RETAINED") {
		return {
			message: [
				`Kept context: pruning ${outcome.candidateToolCalls} completed calls would cost more on the next prompt.`,
				formatCost(outcome.preview),
			].join("\n"),
			type: "info",
		};
	}
	if (outcome.code === "FORCE_PRUNED") {
		return {
			message: [
				`Force-pruned ${formatSummary(outcome.result)}.`,
				"Cost calculation was skipped.",
			].join("\n"),
			type: "info",
		};
	}
	return {
		message: [
			`Pruned ${formatSummary(outcome.result)}.`,
			`Next prompt: ${formatCost(outcome.preview)}`,
		].join("\n"),
		type: "info",
	};
}

function formatSummary(result: PruneResultSummary): string {
	return `${result.removedToolCalls} calls, ${result.removedToolResults} outputs, ${result.removedAssistantMessages} tool-only assistant messages`;
}

function formatCost(preview: PruneCostPreview): string {
	return `${formatTokens(preview.fullTokens)} -> ${formatTokens(preview.prunedTokens)} tokens; ${formatUsd(preview.keepCostUsd)} keep vs ${formatUsd(preview.pruneCostUsd)} pruned.`;
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

function formatUsd(value: number): string {
	return `$${value.toFixed(value < 0.01 ? 4 : 3)}`;
}
