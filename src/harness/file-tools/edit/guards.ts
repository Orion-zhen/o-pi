import type { FailedResult } from "../shared/result.js";
import type { EditSuccess } from "./types.js";

export function isEditSuccess(value: unknown): value is EditSuccess {
	return isRecord(value) && value["status"] === "applied" && typeof value["diff"] === "string";
}
export function isFailedEdit(value: unknown): value is FailedResult {
	return isRecord(value) && value["status"] === "failed" && isRecord(value["error"])
		&& typeof value["error"]["code"] === "string" && typeof value["error"]["message"] === "string";
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
