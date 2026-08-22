import type { LsSuccess } from "./types.js";

export function isLsSuccess(value: unknown): value is LsSuccess {
	if (!isRecord(value) || typeof value["path"] !== "string" || !Array.isArray(value["entries"])) return false;
	if (value["truncated"] === false) return true;
	return value["truncated"] === true
		&& typeof value["returned_entries"] === "number"
		&& typeof value["total_entries"] === "number"
		&& typeof value["continuation_hint"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
