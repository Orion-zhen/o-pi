import { fields, isRecord, scalar } from "../../telemetry/projection.js";
import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { WebFetchDetails, WebFetchParams } from "../core/types.js";
import { record, string, webResultFields } from "./common.js";

export const webFetchTelemetry = defineToolTelemetry<WebFetchParams, WebFetchDetails>({
	input(value) {
		if (!isRecord(value)) return {};
		const url = string(value["url"]);
		return {
			fields: fields({
				input_mode: scalar(value["mode"]),
				input_offset: scalar(value["offset"]),
				input_limit: scalar(value["limit"]),
			}),
			...(url === undefined ? {} : { targets: [{ kind: "url", value: url }] }),
		};
	},
	result(_params, result) {
		return { fields: webResultFields(record(result.details)) };
	},
});
