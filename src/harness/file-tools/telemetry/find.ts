import { defineToolTelemetry, fields } from "../../telemetry/projection.ts";
import type { Candidate } from "../../telemetry/types.ts";
import type { FailedResult } from "../shared/result.ts";
import { isFailed } from "../shared/result.ts";
import type { FindDetails, FindParams } from "../find/types.ts";
import { failureFields, failureScopeFields, projectFileInput } from "./common.ts";

export const findTelemetry = defineToolTelemetry<FindParams, FindDetails | FailedResult>({
	input: projectFileInput<FindParams>(["query", "path", "glob"], "directory", { pathList: true }),
	result(_params, details) {
		if (isFailed(details)) {
			return { fields: { ...failureFields(details), ...failureScopeFields(details) } };
		}
		return {
			fields: fields({
				status: details.status,
				truncated: details.truncated_by.length > 0 ? true : undefined,
				total_candidate_count: details.total_candidates,
				returned_match_count: details.returned_matches,
				scope_count: details.paths.length + (details.scope_errors?.length ?? 0),
				scope_error_count: details.scope_errors?.length ?? 0,
			}),
			candidates: findCandidates(details),
		};
	},
});

function findCandidates(details: FindDetails): Candidate[] {
	return details.displayed_matches.map((match, index) => ({
		kind: match.kind,
		value: match.path,
		rank: index + 1,
		group: "primary",
		sources: ["fuzzy"],
	}));
}
