import { defineToolTelemetry, fields, textFields } from "../../telemetry/projection.ts";
import type { WebFetchDetails, WebFetchParams } from "../core/types.ts";
import { webResultFields } from "./common.ts";

export const webFetchTelemetry = defineToolTelemetry<WebFetchParams, WebFetchDetails>({
	input(params) {
		return {
			fields: fields({
				input_mode: params.mode,
				...textFields("input_find", params.find),
				input_offset: params.offset,
				input_pages: params.pages,
			}),
			targets: [{ kind: "url", value: params.url }],
		};
	},
	result(_params, details) {
		return { fields: {
			...webResultFields(details),
			...fields({ find_matches: details.status === "success" && details.range.kind === "find" ? details.range.matches : undefined }),
		} };
	},
});
