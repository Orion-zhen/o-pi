import { fields } from "../../telemetry/projection.js";
import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { ToolOutcome } from "../shared/result.js";
import { isFailed } from "../shared/result.js";
import type { EditParams, EditSuccess } from "../edit/types.js";
import { failureFields, pathTarget } from "./common.js";

export const editTelemetry = defineToolTelemetry<EditParams, ToolOutcome<EditSuccess>>({
	input(params) {
		let oldChars = 0;
		let newChars = 0;
		let oldLines = 0;
		let newLines = 0;
		for (const edit of params.edits) {
			oldChars += edit.old.length;
			newChars += edit.new.length;
			oldLines += lineCount(edit.old);
			newLines += lineCount(edit.new);
		}
		return {
			fields: fields({
				input_edit_count: params.edits.length,
				input_old_chars: oldChars,
				input_new_chars: newChars,
				input_old_lines: oldLines,
				input_new_lines: newLines,
			}),
			targets: [pathTarget(params.path, "file")],
		};
	},
	result(_params, details) {
		if (isFailed(details)) return { fields: failureFields(details) };
		return {
			fields: fields({
				status: details.status,
				replacement_count: details.replacements,
				before_size_bytes: details.old_size_bytes,
				after_size_bytes: details.new_size_bytes,
				changed: true,
			}),
		};
	},
});

function lineCount(value: string): number {
	if (value.length === 0) return 0;
	let lines = 1;
	for (let index = 0; index < value.length; index += 1) {
		if (value.charCodeAt(index) === 10) lines += 1;
	}
	return lines;
}
