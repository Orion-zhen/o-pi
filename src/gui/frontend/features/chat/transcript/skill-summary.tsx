import { outputPreview } from "../../../../shared/messages/output.ts";
import { isSkillLoadDetails } from "../../../../shared/messages/skill-facts.ts";
import type { TranscriptItem } from "./transcript-items.ts";
import { toolTarget } from "../tools/tool-target.ts";

export function skillCount(items: TranscriptItem[]): number {
	const names = new Set<string>();
	for (const item of items) {
		if (item.kind === "tool" && item.tool.name === "skill") {
			const details = outputPreview(item.tool.output)?.details;
			const name = isSkillLoadDetails(details) ? details.name : toolTarget("skill", item.tool.args);
			if (name) names.add(name);
		}
	}
	return names.size;
}
