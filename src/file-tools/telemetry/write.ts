import { fields, isRecord, textFields } from "../../telemetry/projection.js";
import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { ToolOutcome } from "../shared/result.js";
import type { WriteParams, WriteSuccess } from "../write/types.js";
import { fileResultFields, pathTarget, record, string } from "./common.js";

export const writeTelemetry = defineToolTelemetry<WriteParams, ToolOutcome<WriteSuccess>>({
	input(value) {
		if (!isRecord(value)) return {};
		const path = string(value["path"]);
		return {
			fields: fields(textFields("input_content", value["content"])),
			...(path === undefined ? {} : { targets: [pathTarget(path, "file")] }),
		};
	},
	result(_params, result) {
		return { fields: fileResultFields(record(result.details)) };
	},
});
