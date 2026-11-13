import type { PruneOperationOutcome, PruneResultSummary } from "../service.ts";
import type { PruneCostPreview } from "../prune.ts";

export interface PruneNotice {
	message: string;
	type: "info" | "error";
}

/** 将结构化 prune 结果映射为命令通知。 */
export function formatPruneOutcome(outcome: PruneOperationOutcome): PruneNotice {
	switch (outcome.code) {
		case "CANCELLED": return { message: "Prune cancelled.", type: "info" };
		case "IDLE_WAIT_FAILED":
		case "OPERATION_FAILED": return { message: `Prune failed: ${outcome.message}`, type: "error" };
		case "MODEL_REQUIRED": return { message: "/prune requires an active model", type: "error" };
		case "NO_CANDIDATES": return { message: "No completed tool transactions to prune.", type: "info" };
		case "NO_RESTORE": return { message: "No /prune change to restore.", type: "info" };
		case "RESTORE_COMPACTED": return {
			message: "Cannot restore the most recent /prune change: compaction removed one or more tool transactions. No restore state was written.",
			type: "error",
		};
		case "RESTORED": return {
			message: `Restored the most recent /prune change: ${outcome.restoredToolCalls} tool calls returned to context.`,
			type: "info",
		};
		case "RETAINED": return {
			message: [
				`Kept context: pruning ${outcome.candidateToolCalls} completed calls would cost more on the next prompt.`,
				formatCost(outcome.preview),
			].join("\n"),
			type: "info",
		};
		case "FORCE_PRUNED": return {
			message: [`Force-pruned ${formatSummary(outcome.result)}.`, "Cost calculation was skipped."].join("\n"),
			type: "info",
		};
		case "PRUNED": return {
			message: [`Pruned ${formatSummary(outcome.result)}.`, `Next prompt: ${formatCost(outcome.preview)}`].join("\n"),
			type: "info",
		};
	}
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
