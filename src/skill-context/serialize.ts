import type { SkillActivationEntry, SkillContextEntry, SkillDeactivationEntry } from "./types.js";

/** 将 session custom entry 序列化为稳定的模型可见 selected context 文本，不包含时间戳。 */
export function serializeSkillContextEntry(entry: SkillContextEntry): string | undefined {
	if (entry.kind === "activation") return serializeActivation(entry);
	return serializeDeactivation(entry);
}

function serializeActivation(entry: SkillActivationEntry): string {
	return [
		`<skill name="${escapeXml(entry.name)}" status="active">`,
		entry.body,
		"</skill>",
	].join("\n");
}

function serializeDeactivation(entry: SkillDeactivationEntry): string | undefined {
	if (entry.mode === "hard") return undefined;
	if (entry.name !== undefined) {
		return `<skill name="${escapeXml(entry.name)}" status="inactive"/>`;
	}
	return `<skill status="previous all inactive"/>`;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
