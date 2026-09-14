import { defineToolTelemetry, fields, textFields } from "../../telemetry/projection.ts";
import type { ToolOutcome } from "../shared/result.ts";
import { isFailed } from "../shared/result.ts";
import type { WriteParams, WriteSuccess } from "../write/types.ts";
import { failureFields, pathTarget } from "./common.ts";

export const writeTelemetry = defineToolTelemetry<WriteParams, ToolOutcome<WriteSuccess>>({
	input(params) {
		return {
			fields: fields(textFields("input_content", params.content)),
			targets: [pathTarget(params.path, "file")],
		};
	},
	result(_params, details) {
		if (isFailed(details)) return { fields: failureFields(details) };
		return {
			fields: fields({
				status: details.status,
				size_bytes: details.bytes,
				before_size_bytes: details.before_size_bytes,
				after_size_bytes: details.after_size_bytes,
			}),
		};
	},
});
