import { fields, isRecord, scalar, textFields } from "../../telemetry/projection.js";
import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { Candidate } from "../../telemetry/types.js";
import type { WebSearchDetails, WebSearchParams } from "../core/types.js";
import { record, string, webResultFields } from "./common.js";

export const webSearchTelemetry = defineToolTelemetry<WebSearchParams, WebSearchDetails>({
	input(value) {
		if (!isRecord(value)) return {};
		return { fields: fields({ ...textFields("input_query", value["query"]), input_limit: scalar(value["limit"]) }) };
	},
	result(_params, result) {
		const details = record(result.details);
		const attempts = searchAttempts(details);
		return {
			fields: { ...webResultFields(details), ...fields({
				query_type: scalar(details["query_type"]),
				first_call_accepted: attempts === undefined || attempts.length === 0 ? undefined : attempts[0]?.quality === "accepted",
				provider_latencies: attempts?.flatMap((attempt) => {
					const provider = string(attempt["provider"]);
					const duration = attempt["duration_ms"];
					return provider !== undefined && typeof duration === "number" && Number.isFinite(duration) ? [`${provider}:${duration}`] : [];
				}),
				provider_errors: attempts?.flatMap((attempt) => {
					const provider = string(attempt["provider"]);
					const error = record(attempt["error"]);
					const code = string(error["code"]);
					return provider !== undefined && code !== undefined ? [`${provider}:${code}`] : [];
				}),
			}) },
			candidates: webCandidates(details),
		};
	},
});

function searchAttempts(details: Record<string, unknown>): Record<string, unknown>[] | undefined {
	const value = details["attempts"];
	return Array.isArray(value) ? value.filter(isRecord) : undefined;
}

function webCandidates(details: Record<string, unknown>): Candidate[] {
	const provider = string(details["provider"]) ?? "provider";
	const results = Array.isArray(details["results"]) ? details["results"].filter(isRecord) : [];
	return results.flatMap((item, index) => {
		const url = string(item["url"]);
		if (url === undefined) return [];
		const provenance = Array.isArray(item["provenance"])
			? item["provenance"].filter(isRecord).flatMap((entry) => string(entry["provider"]) ?? [])
			: [];
		return [{
			kind: "url",
			value: url,
			rank: index + 1,
			group: "primary",
			sources: provenance.length > 0 ? provenance : [provider],
		}];
	});
}
