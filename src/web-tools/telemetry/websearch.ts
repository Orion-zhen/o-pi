import { fields, textFields } from "../../telemetry/projection.js";
import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { Candidate } from "../../telemetry/types.js";
import type { WebSearchDetails, WebSearchParams, WebSearchProviderAttempt, WebSearchSuccessDetails } from "../core/types.js";
import { webResultFields } from "./common.js";

export const webSearchTelemetry = defineToolTelemetry<WebSearchParams, WebSearchDetails>({
	input(params) {
		return { fields: fields({ ...textFields("input_query", params.query), input_limit: params.limit }) };
	},
	result(_params, details) {
		const attempts = "attempts" in details ? details.attempts : undefined;
		return {
			fields: { ...webResultFields(details), ...fields({
				query_type: "query_type" in details ? details.query_type : undefined,
				first_call_accepted: firstCallAccepted(attempts),
				provider_latencies: attempts?.flatMap((attempt) => attempt.duration_ms === undefined
					? []
					: [`${attempt.provider}:${attempt.duration_ms}`]),
				provider_errors: attempts?.flatMap((attempt) => attempt.error === undefined
					? []
					: [`${attempt.provider}:${attempt.error.code}`]),
			}) },
			candidates: details.status === "success" ? webCandidates(details) : [],
		};
	},
});

function firstCallAccepted(attempts: WebSearchProviderAttempt[] | undefined): boolean | undefined {
	const first = attempts?.[0];
	return first === undefined ? undefined : first.quality === "accepted";
}

function webCandidates(details: WebSearchSuccessDetails): Candidate[] {
	return details.results.map((item, index) => {
		const sources = item.provenance?.map((entry) => entry.provider) ?? [details.provider];
		return {
			kind: "url",
			value: item.url,
			rank: index + 1,
			group: "primary",
			sources: [...new Set(sources)].sort(),
		};
	});
}
