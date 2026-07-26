import { fields, isRecord, textFields } from "../../telemetry/projection.js";
import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { ToolOutcome } from "../shared/result.js";
import type { EditParams, EditSuccess } from "../edit/types.js";
import { fileResultFields, pathTarget, record, string } from "./common.js";

export const editTelemetry = defineToolTelemetry<EditParams, ToolOutcome<EditSuccess>>({
	input(value) {
		if (!isRecord(value)) return {};
		const path = string(value["path"]);
		const edits = Array.isArray(value["edits"]) ? value["edits"] : [];
		let oldChars = 0;
		let newChars = 0;
		let oldLines = 0;
		let newLines = 0;
		for (const edit of edits) {
			if (!isRecord(edit)) continue;
			const old = textFields("old", edit["old"]);
			const next = textFields("new", edit["new"]);
			oldChars += numeric(old["old_chars"]);
			newChars += numeric(next["new_chars"]);
			oldLines += numeric(old["old_lines"]);
			newLines += numeric(next["new_lines"]);
		}
		return {
			fields: fields({
				input_edit_count: edits.length,
				input_old_chars: oldChars,
				input_new_chars: newChars,
				input_old_lines: oldLines,
				input_new_lines: newLines,
			}),
			...(path === undefined ? {} : { targets: [pathTarget(path, "file")] }),
		};
	},
	result(_params, result) {
		const details = record(result.details);
		return { fields: { ...fileResultFields(details), changed: details["status"] === "applied" } };
	},
});

function numeric(value: unknown): number {
	return typeof value === "number" ? value : 0;
}
