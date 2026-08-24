import { fields, textFields } from "../../telemetry/projection.js";
import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { ToolOutcome } from "../shared/result.js";
import { isFailed } from "../shared/result.js";
import type { WriteParams, WriteSuccess } from "../write/types.js";
import { failureFields, pathTarget } from "./common.js";

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
