import type { LsSuccess } from "./types.js";

export function isLsSuccess(value: unknown): value is LsSuccess {
	return isRecord(value)
		&& typeof value["path"] === "string"
		&& Array.isArray(value["entries"])
		&& typeof value["truncated"] === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
