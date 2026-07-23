import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { Candidate } from "../../telemetry/types.js";
import type { GrepParams, GrepSuccess, ToolOutcome } from "../types.js";
import {
	appendRegionCandidates,
	fileResultFields,
	projectFileInput,
	record,
	sourceLabels,
} from "./common.js";

export const grepTelemetry = defineToolTelemetry<GrepParams, ToolOutcome<GrepSuccess>>({
	input: projectFileInput(["query", "path", "match", "glob"], "path", { pathList: true }),
	result(_params, result) {
		const details = record(result.details);
		return { fields: fileResultFields(details), candidates: grepCandidates(details) };
	},
});

function grepCandidates(details: Record<string, unknown>): Candidate[] {
	const result: Candidate[] = [];
	appendRegionCandidates(result, details["regions"], "primary", (item) => sourceLabels(item["sources"], "lexical"));
	appendRegionCandidates(result, details["nearby"], "nearby", () => ["fuzzy"]);
	appendRegionCandidates(result, details["related"], "related", () => ["repo-map"]);
	return result;
}
