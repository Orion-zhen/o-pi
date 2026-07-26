import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { ToolOutcome } from "../shared/result.js";
import type { ReadFileSuccess, ReadParams } from "../read/types.js";
import { fileResultFields, projectFileInput, record } from "./common.js";

export const readTelemetry = defineToolTelemetry<ReadParams, ToolOutcome<ReadFileSuccess>>({
	input: projectFileInput(["path", "start_line", "end_line"], "file"),
	result(_params, result) {
		const details = record(result.details);
		const skill = record(details["skill_resource"]);
		return {
			fields: {
				...fileResultFields(details),
				...(typeof skill["skill"] === "string" ? { skill: skill["skill"] } : {}),
				...(typeof skill["path"] === "string" ? { skill_resource: skill["path"] } : {}),
			},
		};
	},
});
