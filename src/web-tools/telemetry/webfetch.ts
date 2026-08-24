import { fields } from "../../telemetry/projection.js";
import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { WebFetchDetails, WebFetchParams } from "../core/types.js";
import { webResultFields } from "./common.js";

export const webFetchTelemetry = defineToolTelemetry<WebFetchParams, WebFetchDetails>({
	input(params) {
		return {
			fields: fields({
				input_mode: params.mode,
				input_offset: params.offset,
				input_limit: params.limit,
			}),
			targets: [{ kind: "url", value: params.url }],
		};
	},
	result(_params, details) {
		return { fields: webResultFields(details) };
	},
});
