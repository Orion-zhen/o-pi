import type { FindDetails, FindNearbyResult } from "./types.js";

export function isFindDetails(value: unknown): value is FindDetails {
	return isPlainRecord(value)
		&& typeof value["query"] === "string"
		&& typeof value["path"] === "string"
		&& (value["paths"] === undefined || (Array.isArray(value["paths"]) && value["paths"].every((path) => typeof path === "string")))
		&& (value["scope_errors"] === undefined || Array.isArray(value["scope_errors"]))
		&& (value["strategy"] === "exact" || value["strategy"] === "glob" || value["strategy"] === "fuzzy")
		&& typeof value["totalMatches"] === "number"
		&& Array.isArray(value["matches"])
		&& Array.isArray(value["collapsedGroups"])
		&& typeof value["depthLimited"] === "boolean"
		&& typeof value["resultLimited"] === "boolean"
		&& typeof value["outputTruncated"] === "boolean"
		&& (value["nearby"] === undefined || isFindNearbyResults(value["nearby"]));
}

function isFindNearbyResults(value: unknown): value is FindNearbyResult[] {
	return Array.isArray(value) && value.every((item) =>
		isPlainRecord(item)
		&& typeof item["path"] === "string"
		&& (item["kind"] === "file" || item["kind"] === "directory")
		&& item["reason"] === "name similarity");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
