import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { LsParams, LsSuccess } from "../ls/types.js";
import type { ToolOutcome } from "../shared/result.js";
import { fileResultFields, projectFileInput, record } from "./common.js";

export const lsTelemetry = defineToolTelemetry<LsParams, ToolOutcome<LsSuccess>>({
	input: projectFileInput(["path"], "directory"),
	result(_params, result) {
		const details = record(result.details);
		return { fields: fileResultFields(details) };
	},
});
