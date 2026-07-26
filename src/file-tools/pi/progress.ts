export type MutationProgressPhase = "editing" | "writing" | "verifying";

export interface MutationProgressDetails {
	status: MutationProgressPhase;
	diff?: string;
	replacements?: number;
}

export interface MutationProgressResult {
	content: [];
	details: MutationProgressDetails;
}

export type MutationProgressCallback = (result: MutationProgressResult) => void;

export function mutationProgress(details: MutationProgressDetails): MutationProgressResult {
	return { content: [], details };
}

export function isMutationProgress(value: unknown): value is MutationProgressDetails {
	if (!isRecord(value)) return false;
	return (value["status"] === "editing" || value["status"] === "writing" || value["status"] === "verifying")
		&& (value["diff"] === undefined || typeof value["diff"] === "string")
		&& (value["replacements"] === undefined || typeof value["replacements"] === "number");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
