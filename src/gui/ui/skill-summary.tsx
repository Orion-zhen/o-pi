import { isSkillLoadDetails } from "../skill-facts.ts";
import type { TranscriptItem } from "./transcript-items.ts";
import { toolTarget } from "./tool-target.ts";

export function skillCount(items: TranscriptItem[]): number {
	const names = new Set<string>();
	for (const item of items) {
		if (item.kind === "tool" && item.tool.name === "skill") {
			const details = item.tool.output?.details;
			const name = isSkillLoadDetails(details) ? details.name : toolTarget("skill", item.tool.args);
			if (name) names.add(name);
		}
	}
	return names.size;
}
