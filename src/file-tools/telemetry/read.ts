import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { TelemetryFacts } from "../../telemetry/types.js";
import { parseReadRange } from "../read/range.js";
import type { ReadFileSuccess, ReadParams } from "../read/types.js";
import type { ToolOutcome } from "../shared/result.js";
import { fileResultFields, number, pathTarget, projectFileInput, record, string } from "./common.js";

export const readTelemetry = defineToolTelemetry<ReadParams, ToolOutcome<ReadFileSuccess>>({
	input: projectReadInput,
	result(_params, result) {
		const details = record(result.details);
		const skill = record(details["skill_resource"]);
		const mediaType = string(details["media_type"]);
		const pages = details["pages"];
		const totalPages = number(details["total_pages"]);
		return {
			fields: {
				...fileResultFields(details),
				...(mediaType === undefined ? {} : { media_type: mediaType }),
				...(mediaType === "pdf" && typeof details["truncated"] === "boolean" ? { truncated: details["truncated"] } : {}),
				...(totalPages === undefined ? {} : { total_page_count: totalPages }),
				...(Array.isArray(pages) ? { returned_page_count: pages.length } : {}),
				...(typeof skill["skill"] === "string" ? { skill: skill["skill"] } : {}),
				...(typeof skill["path"] === "string" ? { skill_resource: skill["path"] } : {}),
			},
		};
	},
});

const projectReadInputBase = projectFileInput(["path", "lines", "pages"], "file");

function projectReadInput(value: unknown): TelemetryFacts {
	const facts = projectReadInputBase(value);
	const input = record(value);
	const path = string(input["path"]);
	const lines = string(input["lines"]);
	if (path === undefined || lines === undefined) return facts;
	const parsed = parseReadRange(lines, "lines");
	if (!parsed.ok) return facts;
	return {
		...facts,
		targets: [pathTarget(path, "file", parsed.value.start, parsed.value.end)],
	};
}
