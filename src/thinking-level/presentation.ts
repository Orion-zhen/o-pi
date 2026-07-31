import type { ThinkingLevelOutcome } from "./controller.js";

export interface ThinkingLevelNotice {
	message: string;
	type: "info" | "error";
}

export function formatThinkingLevelOutcome(outcome: ThinkingLevelOutcome): ThinkingLevelNotice | undefined {
	if (outcome.status === "cancelled") return undefined;
	if (outcome.code === "MODEL_REQUIRED") {
		return { message: "/thinking-level requires an active model", type: "error" };
	}
	if (outcome.code === "UNSUPPORTED_LEVEL") {
		return {
			message: `Unsupported thinking level "${outcome.requestedLevel}". Available: ${outcome.availableLevels.join("|")}`,
			type: "error",
		};
	}
	if (outcome.code === "SET_FAILED") {
		return { message: `Failed to set thinking level: ${outcome.message}`, type: "error" };
	}
	return { message: `Thinking level: ${outcome.effectiveLevel}`, type: "info" };
}
