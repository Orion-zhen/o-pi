import { fields } from "../../telemetry/projection.js";
import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { Candidate, Fields } from "../../telemetry/types.js";
import type { GrepParams, GrepSuccess } from "../grep/types.js";
import type { ToolOutcome } from "../shared/result.js";
import {
	appendRegionCandidates,
	number,
	projectFileInput,
	record,
	sourceLabels,
	string,
} from "./common.js";

export const grepTelemetry = defineToolTelemetry<GrepParams, ToolOutcome<GrepSuccess>>({
	input: projectFileInput(["query", "path", "match", "glob"], "path", { pathList: true }),
	result(_params, result) {
		const details = record(result.details);
		return { fields: grepResultFields(details), candidates: grepCandidates(details) };
	},
});

function grepResultFields(details: Record<string, unknown>): Fields {
	const stats = record(details["stats"]);
	const errorDetails = record(record(details["error"])["details"]);
	const scopeErrors = arrayLength(details["scope_errors"]) ?? arrayLength(errorDetails["scope_errors"]);
	const paths = stringList(details["paths"]) ?? stringList(errorDetails["paths"]);
	const truncationReasons = stringList(details["truncated_by"]);
	return fields({
		status: string(details["status"]),
		error_code: string(record(details["error"])["code"]),
		truncated: truncationReasons !== undefined && truncationReasons.length > 0 ? true : undefined,
		truncation_reasons: truncationReasons,
		total_candidate_count: number(details["total_candidates"]),
		returned_match_count: number(details["returned_regions"]),
		returned_file_count: number(details["returned_files"]),
		approx_token_count: number(details["approx_tokens"]),
		traversed_entry_count: number(stats["traversed_entries"]),
		searched_file_count: number(stats["searched_files"]),
			searched_byte_count: number(stats["searched_bytes"]),
			parsed_file_count: number(stats["parsed_files"]),
			skipped_file_count: skippedCount(stats["skipped_files"]),
			scope_count: paths === undefined ? (typeof details["path"] === "string" ? 1 + (scopeErrors ?? 0) : undefined) : paths.length + (scopeErrors ?? 0),
		scope_error_count: scopeErrors,
	});
}

function grepCandidates(details: Record<string, unknown>): Candidate[] {
	const result: Candidate[] = [];
	appendRegionCandidates(result, details["regions"], "primary", (item) => sourceLabels(item["sources"], "lexical"));
	appendRegionCandidates(result, details["nearby"], "nearby", () => ["fuzzy"]);
	return result;
}

function arrayLength(value: unknown): number | undefined {
	return Array.isArray(value) ? value.length : undefined;
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function skippedCount(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	const skipped = record(value);
	let total = 0;
	for (const value of Object.values(skipped)) if (typeof value === "number" && Number.isFinite(value)) total += value;
	return total;
}
