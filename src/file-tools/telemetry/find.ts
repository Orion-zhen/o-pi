import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { Candidate } from "../../telemetry/types.js";
import type { FailedResult, FindDetails, FindParams } from "../types.js";
import {
	appendPathCandidates,
	fileResultFields,
	projectFileInput,
	record,
	sourceLabels,
} from "./common.js";

export const findTelemetry = defineToolTelemetry<FindParams, FindDetails | FailedResult>({
	input: projectFileInput(["query", "path"], "directory"),
	result(_params, result) {
		const details = record(result.details);
		return { fields: fileResultFields(details), candidates: findCandidates(details) };
	},
});

function findCandidates(details: Record<string, unknown>): Candidate[] {
	const result: Candidate[] = [];
	const sourceMap = record(details["candidateSources"]);
	const strategy = details["strategy"] === "fuzzy" ? "fuzzy" : details["strategy"] === "glob" ? "glob" : "lexical";
	appendPathCandidates(result, details["displayedMatches"] ?? details["matches"], "primary", (path) => {
		const labels = sourceLabels(sourceMap[path], strategy);
		return strategy === "fuzzy" ? [...new Set([...labels, "fuzzy"])].sort() : labels;
	});
	appendPathCandidates(result, details["displayedCollapsedGroups"] ?? details["collapsedGroups"], "collapsed", () => ["collapsed"], "group");
	appendPathCandidates(result, details["nearby"], "nearby", () => ["fuzzy"]);
	appendPathCandidates(result, details["related"], "related", () => ["repo-map"]);
	return result;
}
