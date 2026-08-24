import { fields } from "../../telemetry/projection.js";
import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { LsParams, LsSuccess } from "../ls/types.js";
import { isFailed, type ToolOutcome } from "../shared/result.js";
import { failureFields, projectFileInput } from "./common.js";

export const lsTelemetry = defineToolTelemetry<LsParams, ToolOutcome<LsSuccess>>({
	input: projectFileInput<LsParams>(["path"], "directory"),
	result(_params, details) {
		if (isFailed(details)) return { fields: failureFields(details) };
		return {
			fields: fields({
				truncated: details.truncated ? true : undefined,
				returned_entry_count: details.truncated ? details.returned_entries : undefined,
			}),
		};
	},
});
