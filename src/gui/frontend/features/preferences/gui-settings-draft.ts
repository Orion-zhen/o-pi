import { applyEdits, modify, parse } from "jsonc-parser";
import { equalConfigValues, mergeConfigValues } from "../../../../harness/config-values.ts";
import type { GuiConfigDocument, GuiPreferences } from "../../../shared/config/preferences.ts";
import { parseGuiPreferences } from "../../../shared/config/gui-validation.ts";

export const guiSections = ["appearance", "interaction", "desktopWeb"] as const;
export type GuiSection = typeof guiSections[number];
export type ReadyGuiConfig = Extract<GuiConfigDocument, { state: "ready" }>;
const sectionKeys = {
	appearance: ["theme", "themeColor", "fonts", "fontSizes", "materials"],
	interaction: ["sendShortcut", "openFileLinksExternally", "preventSleepWhileRunning"],
	desktopWeb: ["desktopWeb"],
} as const;

export function sectionChanged(before: GuiPreferences, after: GuiPreferences, section: GuiSection): boolean {
	return sectionKeys[section].some((key) => key === "themeColor"
		? before.themeColor.toUpperCase() !== after.themeColor.toUpperCase()
		: !equalConfigValues(before[key], after[key]));
}

export function editPreference(document: ReadyGuiConfig, path: string[], value: unknown): ReadyGuiConfig {
	const content = document.content || "{}\n";
	const next = applyEdits(content, modify(content, path, value, { formattingOptions: { insertSpaces: false, tabSize: 4 } }));
	const overrides: unknown = parse(next);
	return { ...document, content: next, value: mergeConfigValues(document.defaults, overrides) as GuiPreferences };
}

export function readPreferenceSource(base: GuiConfigDocument, content: string): GuiConfigDocument {
	try { return { path: base.path, defaults: base.defaults, content, state: "ready", value: parseGuiPreferences(content, base.defaults) }; }
	catch (error) { return { path: base.path, defaults: base.defaults, content, state: "error", message: error instanceof Error ? error.message : String(error) }; }
}

export function resetSection(document: ReadyGuiConfig, section: GuiSection): ReadyGuiConfig {
	return sectionKeys[section].reduce((draft, key) => editPreference(draft, [key], undefined), document);
}

export function preferenceSave(base: ReadyGuiConfig, draft: ReadyGuiConfig, latest: GuiConfigDocument) {
	const keys = guiSections.filter((section) => sectionChanged(base.value, draft.value, section)).flatMap((section) => [...sectionKeys[section]]);
	const originalValues = parse(base.content || "{}") as Record<string, unknown>;
	const draftValues = parse(draft.content || "{}") as Record<string, unknown>;
	// 只合并未编辑分区的外部修改。已编辑分区冲突时交给后端拒绝保存。
	if (latest.state === "error") return { original: base.content, content: draft.content };
	const latestValues = parse(latest.content || "{}") as Record<string, unknown>;
	if (keys.some((key) => JSON.stringify(originalValues[key]) !== JSON.stringify(latestValues[key]))) {
		return { original: base.content, content: draft.content };
	}
	let content = latest.content || "{}\n";
	for (const key of keys) content = applyEdits(content, modify(content, [key], draftValues[key], { formattingOptions: { insertSpaces: false, tabSize: 4 } }));
	return { original: latest.content, content };
}
