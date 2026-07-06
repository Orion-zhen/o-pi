import type { SkillActivationEntry, SkillContextEntry, SkillDeactivationEntry } from "./types.js";

/** 将 session custom entry 序列化为稳定的模型可见 selected context 文本，不包含时间戳。 */
export function serializeSkillContextEntry(entry: SkillContextEntry): string | undefined {
	if (entry.kind === "activation") return serializeActivation(entry);
	return serializeDeactivation(entry);
}

function serializeActivation(entry: SkillActivationEntry): string {
	return [
		`<loaded_skill name="${escapeXml(entry.name)}">`,
		entry.body,
		"</loaded_skill>",
	].join("\n");
}

function serializeDeactivation(entry: SkillDeactivationEntry): string | undefined {
	if (entry.mode === "hard") return undefined;
	if (entry.name !== undefined) {
		return [
			`<unload_skill name="${escapeXml(entry.name)}">`,
			"Do not apply this skill unless it is loaded again.",
			"</unload_skill>",
		].join("\n");
	}
	return [
		`<unload_previous_skills>`,
		"No previously loaded skill is active unless loaded again.",
		"</unload_previous_skills>",
	].join("\n");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
