import type { GrepNearbyResult, GrepRegion, GrepRelatedResult, GrepSuccess, TruncationReason } from "../grep/types.js";
import type { FailedResult } from "../shared/result.js";

const TRUNCATION_REASONS = new Set<TruncationReason>([
	"traversal_limit",
	"text_byte_limit",
	"semantic_candidate_limit",
	"result_limit",
	"token_budget",
]);

export function isFailedDetails(value: unknown): value is FailedResult {
	if (!isPlainRecord(value) || value["status"] !== "failed" || !isPlainRecord(value["error"])) return false;
	const error = value["error"];
	return typeof error["code"] === "string" && typeof error["message"] === "string";
}

export function isGrepSuccessDetails(value: unknown): value is GrepSuccess {
	return isPlainRecord(value)
		&& value["status"] === "success"
		&& typeof value["query"] === "string"
		&& typeof value["path"] === "string"
		&& (value["match"] === "auto" || value["match"] === "literal" || value["match"] === "regex")
		&& isNumber(value["total_candidates"])
		&& isNumber(value["returned_regions"])
		&& isNumber(value["returned_files"])
		&& isNumber(value["approx_tokens"])
		&& isGrepStats(value["stats"])
		&& isTruncationReasons(value["truncated_by"])
		&& isGrepRegions(value["regions"])
		&& (value["nearby"] === undefined || isGrepNearbyResults(value["nearby"]))
		&& (value["related"] === undefined || isGrepRelatedResults(value["related"]));
}

export function isGrepRelatedResults(value: unknown): value is GrepRelatedResult[] {
	return Array.isArray(value) && value.every((item) =>
		isPlainRecord(item)
		&& typeof item["path"] === "string"
		&& typeof item["kind"] === "string"
		&& (item["start_line"] === undefined || isNumber(item["start_line"]))
		&& (item["end_line"] === undefined || isNumber(item["end_line"]))
		&& isStrings(item["sources"])
		&& item["query_match"] === "not_guaranteed"
		&& isStrings(item["relations"]));
}

export function isFileToolName(value: string): boolean {
	return value === "ls" || value === "find" || value === "grep" || value === "read" || value === "write" || value === "edit";
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGrepRegions(value: unknown): value is GrepRegion[] {
	return Array.isArray(value) && value.every((item) =>
		isPlainRecord(item)
		&& typeof item["path"] === "string"
		&& isNumber(item["start_line"])
		&& isNumber(item["end_line"])
		&& typeof item["kind"] === "string"
		&& (item["detail"] === "body" || item["detail"] === "snippet" || item["detail"] === "signature")
		&& (item["query_match"] === "verified" || item["query_match"] === "semantic")
		&& (item["roles"] === undefined || isStrings(item["roles"]))
		&& isStrings(item["reasons"])
		&& isStrings(item["sources"])
		&& (item["match_lines"] === undefined || isNumbers(item["match_lines"]))
		&& (item["content"] === undefined || typeof item["content"] === "string"));
}

function isGrepNearbyResults(value: unknown): value is GrepNearbyResult[] {
	return Array.isArray(value) && value.every((item) =>
		isPlainRecord(item)
		&& typeof item["path"] === "string"
		&& isNumber(item["start_line"])
		&& isNumber(item["end_line"])
		&& typeof item["kind"] === "string"
		&& item["query_match"] === "not_guaranteed"
		&& (item["reason"] === "symbol similarity" || item["reason"] === "partial terms" || item["reason"] === "path similarity"));
}

function isGrepStats(value: unknown): boolean {
	return isPlainRecord(value)
		&& isNumber(value["traversed_entries"])
		&& isNumber(value["searched_files"])
		&& isNumber(value["searched_bytes"])
		&& isNumber(value["parsed_files"]);
}

function isTruncationReasons(value: unknown): value is TruncationReason[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && TRUNCATION_REASONS.has(item as TruncationReason));
}

function isStrings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNumbers(value: unknown): value is number[] {
	return Array.isArray(value) && value.every(isNumber);
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
