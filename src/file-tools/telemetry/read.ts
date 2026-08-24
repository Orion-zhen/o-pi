import { fields } from "../../telemetry/projection.js";
import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { TelemetryFacts } from "../../telemetry/types.js";
import { parseReadRange } from "../read/range.js";
import type { ReadFileSuccess, ReadParams } from "../read/types.js";
import { isFailed, type ToolOutcome } from "../shared/result.js";
import { failureFields, pathTarget, projectFileInput } from "./common.js";

export const readTelemetry = defineToolTelemetry<ReadParams, ToolOutcome<ReadFileSuccess>>({
	input: projectReadInput,
	result(_params, details) {
		if (isFailed(details)) return { fields: failureFields(details) };
		const skill = details.skill_resource;
		if (!("media_type" in details)) {
			return {
				fields: fields({
					size_bytes: details.size_bytes,
					truncated: details.truncated ? true : undefined,
					skill: skill?.skill,
					skill_resource: skill?.path,
				}),
			};
		}
		if (details.media_type === "pdf") {
			return {
				fields: fields({
					size_bytes: details.size_bytes,
					media_type: details.media_type,
					truncated: details.truncated,
					total_page_count: details.total_pages,
					returned_page_count: details.pages.length,
					skill: skill?.skill,
					skill_resource: skill?.path,
				}),
			};
		}
		return {
			fields: fields({
				size_bytes: details.size_bytes,
				media_type: details.media_type,
				skill: skill?.skill,
				skill_resource: skill?.path,
			}),
		};
	},
});

const projectReadInputBase = projectFileInput<ReadParams>(["path", "lines", "pages"], "file");

function projectReadInput(value: ReadParams): TelemetryFacts {
	const facts = projectReadInputBase(value);
	if (value.lines === undefined) return facts;
	const parsed = parseReadRange(value.lines, "lines");
	if (!parsed.ok) return facts;
	return {
		...facts,
		targets: [pathTarget(value.path, "file", parsed.value.start, parsed.value.end)],
	};
}
