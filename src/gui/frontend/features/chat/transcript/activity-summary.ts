import { outputPreview } from "../../../../shared/messages/output.ts";
import { isSkillLoadDetails } from "../../../../shared/messages/skill-facts.ts";
import type { TranscriptItem } from "./transcript-items.ts";
import { toolTarget } from "../tools/tool-target.ts";

export function summarizeActivity(items: TranscriptItem[]) {
	const skills = new Set<string>();
	let thoughts = 0, tools = 0, failures = 0;
	let pruned = false;
	for (const item of items) {
		if (item.kind === "thinking") thoughts++;
		if (item.kind !== "tool") continue;
		tools++;
		if (item.tool.state === "failed") failures++;
		pruned ||= item.pruned;
		if (item.tool.name === "skill") {
			const details = outputPreview(item.tool.output)?.details;
			const name = isSkillLoadDetails(details) ? details.name : toolTarget("skill", item.tool.args);
			if (name) skills.add(name);
		}
	}
	const counts = [
		thoughts ? `${thoughts} 段思考` : "",
		skills.size ? `${skills.size} 个技能` : "",
		tools ? `${tools} 次工具调用` : "",
		failures ? `${failures} 次失败` : "",
	].filter(Boolean).join(" · ");
	return { counts, pruned };
}
