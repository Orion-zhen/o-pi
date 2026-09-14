import { defineToolTelemetry, fields } from "../../telemetry/projection.ts";
import type { LsParams, LsSuccess } from "../ls/types.ts";
import { isFailed, type ToolOutcome } from "../shared/result.ts";
import { failureFields, projectFileInput } from "./common.ts";

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
