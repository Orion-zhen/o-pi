import type { FindDetails } from "./types.js";

export function isFindDetails(value: unknown): value is FindDetails {
	return isPlainRecord(value)
		&& value["status"] === "success"
		&& typeof value["query"] === "string"
		&& typeof value["path"] === "string"
		&& Array.isArray(value["paths"])
		&& value["paths"].every((path) => typeof path === "string")
		&& (value["glob"] === undefined || typeof value["glob"] === "string")
		&& (value["scope_errors"] === undefined || Array.isArray(value["scope_errors"]))
		&& typeof value["total_candidates"] === "number"
		&& typeof value["total_matches"] === "number"
		&& typeof value["returned_matches"] === "number"
		&& Array.isArray(value["matches"])
		&& Array.isArray(value["displayed_matches"])
		&& isPlainRecord(value["stats"])
		&& Array.isArray(value["truncated_by"])
		&& isPlainRecord(value["ranking"]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
