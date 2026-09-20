import { defineToolTelemetry, fields } from "../../telemetry/projection.ts";
import type { TelemetryFacts } from "../../telemetry/types.ts";
import { parseReadRanges } from "../../content-ranges.ts";
import type { ReadFileSuccess, ReadParams } from "../read/types.ts";
import { isFailed, type ToolOutcome } from "../shared/result.ts";
import { failureFields, pathTarget, projectFileInput } from "./common.ts";

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
	const parsed = parseReadRanges(value.lines, "lines");
	if (!parsed.ok) return facts;
	return {
		...facts,
		targets: parsed.value.map((range) => pathTarget(value.path, "file", range.start, range.end)),
	};
}
