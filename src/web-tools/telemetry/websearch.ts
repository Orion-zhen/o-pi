import { fields, isRecord, scalar, textFields } from "../../telemetry/projection.js";
import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { Candidate } from "../../telemetry/types.js";
import type { WebSearchDetails, WebSearchParams } from "../types.js";
import { record, string, webResultFields } from "./common.js";

export const webSearchTelemetry = defineToolTelemetry<WebSearchParams, WebSearchDetails>({
	input(value) {
		if (!isRecord(value)) return {};
		return { fields: fields({ ...textFields("input_query", value["query"]), input_limit: scalar(value["limit"]) }) };
	},
	result(_params, result) {
		const details = record(result.details);
		return {
			fields: { ...webResultFields(details), ...fields({
				primary_provider: scalar(details["primary_provider"]),
				query_type: scalar(details["query_type"]),
				formal_provider_calls: scalar(details["formal_provider_calls"]),
				first_call_accepted: scalar(details["first_call_accepted"]),
				fallback_reason: scalar(details["fallback_reason"]),
				secondary_new_results: scalar(details["secondary_new_results"]),
				reused: scalar(details["reused"]),
				provider_latencies: stringArray(details["provider_latencies"]),
				provider_errors: stringArray(details["provider_errors"]),
				corpus_discovered: scalar(details["corpus_discovered"]),
				corpus_fetched: scalar(details["corpus_fetched"]),
				corpus_cited: scalar(details["corpus_cited"]),
				approximate_reformulation: scalar(details["approximate_reformulation"]),
			}) },
			candidates: webCandidates(details),
		};
	},
});

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

function stringArray(value: unknown): string[] | undefined { return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined; }
