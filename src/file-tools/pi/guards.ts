import type {
	EditSuccess,
	FailedResult,
	FindDetails,
	LsSuccess,
	ReadFileSuccess,
	ReadImageSuccess,
	ReadSuccess,
	WriteSuccess,
} from "../types.js";

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
		&& (value["strategy"] === "exact" || value["strategy"] === "glob" || value["strategy"] === "fuzzy")
		&& typeof value["totalMatches"] === "number"
		&& typeof value["scannedEntries"] === "number"
		&& Array.isArray(value["matches"])
		&& Array.isArray(value["collapsedGroups"]);
}

export function isLsSuccess(value: unknown): value is LsSuccess {
	return isPlainRecord(value) && typeof value["path"] === "string" && Array.isArray(value["entries"]) && typeof value["truncated"] === "boolean";
}

export function isReadFileSuccess(value: unknown): value is ReadFileSuccess {
	return isReadSuccess(value) || isReadImageSuccess(value);
}

export function isReadSuccess(value: unknown): value is ReadSuccess {
	return isPlainRecord(value)
		&& typeof value["path"] === "string"
		&& typeof value["content"] === "string"
		&& typeof value["start_line"] === "number"
		&& typeof value["end_line"] === "number"
		&& typeof value["total_lines"] === "number";
}

export function isReadImageSuccess(value: unknown): value is ReadImageSuccess {
	if (!isPlainRecord(value) || value["media_type"] !== "image" || typeof value["path"] !== "string" || typeof value["content"] !== "string") {
		return false;
	}
	const image = value["image"];
	return isPlainRecord(image) && typeof image["data"] === "string" && typeof image["mime_type"] === "string";
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
