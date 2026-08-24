import { fields } from "../../telemetry/projection.js";
import type { Fields } from "../../telemetry/types.js";
import type { WebFetchDetails, WebSearchDetails } from "../core/types.js";

type WebResultDetails = WebFetchDetails | WebSearchDetails;

export function webResultFields(details: WebResultDetails): Fields {
	const attempts = "attempts" in details ? details.attempts : undefined;
	const errorCode = details.status === "failed" ? details.error.code : undefined;
	return fields({
		status: details.status,
		error_code: errorCode,
		provider: "provider" in details ? details.provider : undefined,
		http_status: "http_status" in details ? details.http_status : undefined,
		attempt_count: attempts?.length,
		fallback: attempts === undefined ? undefined : attempts.length > 1,
		truncated: details.status === "success" && "range" in details ? details.range.has_more : undefined,
		format: details.status === "success" && "format" in details ? details.format : undefined,
		total_chars: details.status === "success" && "total_chars" in details ? details.total_chars : undefined,
	});
}
