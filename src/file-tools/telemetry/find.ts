import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { Candidate } from "../../telemetry/types.js";
import type { FailedResult } from "../shared/result.js";
import type { FindDetails, FindParams } from "../find/types.js";
import { appendPathCandidates, fileResultFields, projectFileInput, record } from "./common.js";

export const findTelemetry = defineToolTelemetry<FindParams, FindDetails | FailedResult>({
	input: projectFileInput(["query", "path", "glob"], "directory", { pathList: true }),
	result(_params, result) {
		const details = record(result.details);
		return { fields: fileResultFields(details), candidates: findCandidates(details) };
	},
});

function findCandidates(details: Record<string, unknown>): Candidate[] {
	const result: Candidate[] = [];
	appendPathCandidates(
		result,
		details["displayed_matches"] ?? details["matches"],
		"primary",
		() => ["fuzzy"],
	);
	return result;
}
