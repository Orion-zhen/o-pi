import type { GrepRegion, GrepSuccess, TruncationReason } from "../grep/types.js";
import type { FailedResult } from "../shared/result.js";

const GREP_MATCHED_BY = new Set([
	"exact-qualified-symbol", "exact-symbol", "symbol-prefix", "literal", "regex", "lexical", "related",
]);
const TRUNCATION_REASONS = new Set<TruncationReason>([
	"depth_limit",
	"entry_limit",
	"byte_limit",
	"result_limit",
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
		&& (value["query_mode"] === "regex" || value["query_mode"] === "literal_fallback")
		&& typeof value["path"] === "string"
		&& (value["paths"] === undefined || isStrings(value["paths"]))
		&& (value["scope_errors"] === undefined || isGrepScopeErrors(value["scope_errors"]))
		&& isNumber(value["total_candidates"])
		&& isNumber(value["returned_regions"])
		&& isNumber(value["returned_files"])
		&& isNumber(value["approx_tokens"])
		&& isGrepStats(value["stats"])
			&& isTruncationReasons(value["truncated_by"])
			&& isGrepRegions(value["regions"]);
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
		&& (item["symbol"] === undefined || typeof item["symbol"] === "string")
		&& (item["declaration"] === undefined || typeof item["declaration"] === "string")
		&& (item["query_match"] === "verified" || item["query_match"] === "semantic")
		&& (item["roles"] === undefined || isStrings(item["roles"]))
		&& isMatchedBy(item["matched_by"])
		&& isStrings(item["sources"])
		&& (item["match_lines"] === undefined || isNumbers(item["match_lines"]))
		&& (item["display_lines"] === undefined || isDisplayLines(item["display_lines"])));
}

function isDisplayLines(value: unknown): boolean {
	return Array.isArray(value) && value.every((item) => isPlainRecord(item)
		&& isNumber(item["line"])
		&& typeof item["text"] === "string"
		&& (item["type"] === "match" || item["type"] === "evidence"));
}

function isMatchedBy(value: unknown): boolean {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && GREP_MATCHED_BY.has(item));
}

function isGrepStats(value: unknown): boolean {
	return isPlainRecord(value)
		&& isNumber(value["traversed_entries"])
		&& isNumber(value["searched_files"])
		&& isNumber(value["searched_bytes"])
		&& isNumber(value["text_hits"])
		&& isNumber(value["parsed_files"])
		&& isNumber(value["dropped_text_hits"])
		&& isNumber(value["dropped_related_anchors"])
		&& isNumber(value["dropped_related_results"])
		&& isNumber(value["ast_skipped_oversized_files"])
		&& (value["skipped_files"] === undefined || isGrepSkippedFiles(value["skipped_files"]));
}

function isGrepScopeErrors(value: unknown): boolean {
	return Array.isArray(value) && value.every((item) => isPlainRecord(item)
		&& typeof item["path"] === "string"
		&& isPlainRecord(item["error"])
		&& typeof item["error"]["code"] === "string"
		&& typeof item["error"]["message"] === "string");
}

function isGrepSkippedFiles(value: unknown): boolean {
	if (!isPlainRecord(value)) return false;
	return ["binary", "invalid_utf8", "access_denied", "too_large", "changed"]
		.every((key) => value[key] === undefined || isNumber(value[key]));
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
