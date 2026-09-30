import { applyEdits, modify, parse } from "jsonc-parser";
import type { GuiConfigDocument, GuiPreferences } from "../preferences.ts";

export type GuiSection = "appearance" | "interaction" | "desktopWeb";
export type ReadyGuiConfig = Extract<GuiConfigDocument, { state: "ready" }>;
const sectionKeys = {
	appearance: ["theme", "themeColor", "fonts", "fontSizes"],
	interaction: ["sendShortcut"],
	desktopWeb: ["desktopWeb"],
} as const;

export function editPreference(document: ReadyGuiConfig, path: string[], value: unknown): ReadyGuiConfig {
	const content = document.content || "{}\n";
	const next = applyEdits(content, modify(content, path, value, { formattingOptions: { insertSpaces: false, tabSize: 4 } }));
	const overrides = parse(next) as Partial<GuiPreferences>;
	const defaults = document.defaults;
	return { ...document, content: next, value: {
		...defaults, ...overrides,
		fonts: { ...defaults.fonts, ...overrides.fonts },
		fontSizes: { ...defaults.fontSizes, ...overrides.fontSizes },
		desktopWeb: { ...defaults.desktopWeb, ...overrides.desktopWeb },
		sessionCache: { ...defaults.sessionCache, ...overrides.sessionCache },
	} };
}

export function resetSection(document: ReadyGuiConfig, section: GuiSection): ReadyGuiConfig {
	return sectionKeys[section].reduce((draft, key) => editPreference(draft, [key], undefined), document);
}

export function sectionSave(base: ReadyGuiConfig, draft: ReadyGuiConfig, latest: GuiConfigDocument, section: GuiSection) {
	const originalValues = parse(base.content || "{}") as Record<string, unknown>;
	const latestValues = parse(latest.content || "{}") as Record<string, unknown>;
	const draftValues = parse(draft.content || "{}") as Record<string, unknown>;
	// 合并其它页面的保存。本页被外部修改时保留原始版本，让后端报告冲突。
	const original = latest.state === "ready" && sectionKeys[section].every((key) => JSON.stringify(originalValues[key]) === JSON.stringify(latestValues[key]))
		? latest.content : base.content;
	let content = original || "{}\n";
	for (const key of sectionKeys[section]) content = applyEdits(content, modify(content, [key], draftValues[key], { formattingOptions: { insertSpaces: false, tabSize: 4 } }));
	return { original, content };
}
