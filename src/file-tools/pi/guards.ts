import type {
	EditSuccess,
	FindDetails,
	FindNearbyResult,
	RepoMapRelatedResult,
	WriteSuccess,
} from "../types.js";
import type { FailedResult } from "../shared/result.js";

export function isEditSuccessDetails(value: unknown): value is EditSuccess {
	return isPlainRecord(value) && value["status"] === "applied" && typeof value["diff"] === "string";
}

export function isFailedEditDetails(value: unknown): value is FailedResult {
	return isFailedDetails(value);
}

export function isFailedDetails(value: unknown): value is FailedResult {
	if (!isPlainRecord(value) || value["status"] !== "failed" || !isPlainRecord(value["error"])) return false;
	const error = value["error"];
	return typeof error["code"] === "string" && typeof error["message"] === "string";
}

export function isFindDetails(value: unknown): value is FindDetails {
	return isPlainRecord(value)
		&& typeof value["query"] === "string"
		&& typeof value["path"] === "string"
		&& (value["paths"] === undefined || (Array.isArray(value["paths"]) && value["paths"].every((path) => typeof path === "string")))
		&& (value["scope_errors"] === undefined || Array.isArray(value["scope_errors"]))
		&& (value["strategy"] === "exact" || value["strategy"] === "glob" || value["strategy"] === "fuzzy")
		&& typeof value["totalMatches"] === "number"
		&& typeof value["scannedEntries"] === "number"
		&& Array.isArray(value["matches"])
		&& Array.isArray(value["collapsedGroups"])
		&& typeof value["scanTruncated"] === "boolean"
		&& typeof value["resultLimited"] === "boolean"
		&& typeof value["outputTruncated"] === "boolean"
		&& (value["nearby"] === undefined || isFindNearbyResults(value["nearby"]))
		&& (value["related"] === undefined || isRepoMapRelatedResults(value["related"]));
}

function isFindNearbyResults(value: unknown): value is FindNearbyResult[] {
	return Array.isArray(value) && value.every((item) =>
		isPlainRecord(item)
		&& typeof item["path"] === "string"
		&& (item["kind"] === "file" || item["kind"] === "directory")
		&& item["reason"] === "name similarity");
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

export function isWriteSuccess(value: unknown): value is WriteSuccess {
	return isPlainRecord(value) && value["status"] === "written" && typeof value["path"] === "string" && typeof value["bytes"] === "number";
}

export function isFileToolName(value: string): boolean {
	return value === "ls" || value === "find" || value === "grep" || value === "read" || value === "write" || value === "edit";
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
