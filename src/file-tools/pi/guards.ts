import type { FailedResult } from "../shared/result.js";
import type { RepoMapRelatedResult } from "../types.js";

export function isFailedDetails(value: unknown): value is FailedResult {
	if (!isPlainRecord(value) || value["status"] !== "failed" || !isPlainRecord(value["error"])) return false;
	const error = value["error"];
	return typeof error["code"] === "string" && typeof error["message"] === "string";
}

export function isRepoMapRelatedResults(value: unknown): value is RepoMapRelatedResult[] {
	return Array.isArray(value) && value.every((item) =>
		isPlainRecord(item)
		&& typeof item["path"] === "string"
		&& typeof item["kind"] === "string"
		&& item["source"] === "repo-map"
		&& item["query_match"] === "not_guaranteed"
		&& Array.isArray(item["relations"])
		&& item["relations"].every((relation) => typeof relation === "string"));
}

export function isFileToolName(value: string): boolean {
	return value === "ls" || value === "find" || value === "grep" || value === "read" || value === "write" || value === "edit";
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
