import type { WriteSuccess } from "./types.js";

export function isWriteSuccess(value: unknown): value is WriteSuccess {
	return isRecord(value) && value["status"] === "written" && typeof value["path"] === "string" && typeof value["bytes"] === "number";
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
