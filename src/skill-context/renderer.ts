import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { SKILL_CONTEXT_STATUS_MESSAGE, type SkillContextStatusMessage } from "./types.js";

/** 注册 skill 状态卡片；复用 Pi skill 卡片的 custom message 背景与 [skill] 标签风格。 */
export function registerSkillStatusRenderer(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
	pi.registerMessageRenderer<SkillContextStatusMessage>(SKILL_CONTEXT_STATUS_MESSAGE, (message, { expanded }, theme) => {
		const details = message.details;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const title = formatTitle(details, theme);
		box.addChild(new Text(title, 0, 0));
		if (expanded) {
			for (const line of formatDetails(details, theme)) box.addChild(new Text(line, 0, 0));
		}
		return box;
	});
}

export function skillStatusContent(details: SkillContextStatusMessage): string {
	const target = details.name ?? "all skills";
	if (details.action === "loaded") return `skill ${target} loaded`;
	if (details.action === "cleared") return `skill ${target} hard cleared`;
	return `skill ${target} inactive`;
}

function formatTitle(details: SkillContextStatusMessage | undefined, theme: Parameters<Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>[2]): string {
	const safe = details ?? { action: "inactive" as const };
	const label = theme.fg("customMessageLabel", `${theme.bold("[skill]")} `);
	const name = theme.fg("customMessageText", safe.name ?? "all");
	const status = statusText(safe);
	if (safe.action === "loaded") return `${label}${name} ${theme.fg("success", status)}`;
	return `${label}${name} ${theme.fg("warning", status)}`;
}

function formatDetails(details: SkillContextStatusMessage | undefined, theme: Parameters<Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>[2]): string[] {
	if (details === undefined) return [];
	const lines: string[] = [];
	if (details.chars !== undefined) lines.push(theme.fg("dim", `  ${details.chars} chars`));
	if (details.mode === "lazy") lines.push(theme.fg("dim", "  retained until hard clear/compaction"));
	if (details.mode === "hard") lines.push(theme.fg("warning", "  future context omits body; cache prefix may reset"));
	if (details.path !== undefined) lines.push(theme.fg("dim", `  ${details.path}`));
	return lines;
}

function statusText(details: SkillContextStatusMessage): string {
	if (details.action === "loaded") return "loaded";
	if (details.action === "cleared") return "hard cleared";
	return "inactive";
}
