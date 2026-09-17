import { useLayoutEffect } from "react";
import type { GuiPreferences } from "../preferences.ts";
import { applyThemeColor } from "./theme/apply.ts";

export const genericFamilies = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong"]);

export function fontFamily(fonts: readonly string[], kind: "ui" | "code"): string {
	const fallback = kind === "ui" ? "system-ui, sans-serif" : "ui-monospace, monospace";
	const families = fonts.map((font) => genericFamilies.has(font.toLowerCase()) ? font.toLowerCase()
		: `"${font.replace(/[\u0000-\u001f\u007f"\\]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `)}"`);
	return [...families, fallback].join(", ");
}

/** 应用于根节点，Portal 菜单和弹窗也共享配色与排版。 */
export function usePreferences(value: GuiPreferences | undefined): void {
	useLayoutEffect(() => {
		if (value) applyThemeColor(value.themeColor);
	}, [value?.themeColor]);
	useLayoutEffect(() => {
		if (!value) return;
		const root = document.documentElement;
		root.dataset.theme = value.theme;
		root.style.setProperty("--gui-font-ui", fontFamily(value.fonts.ui, "ui"));
		root.style.setProperty("--gui-font-code", fontFamily(value.fonts.code, "code"));
		root.style.setProperty("--text-ui", `${value.fontSizes.ui / 16}rem`);
		root.style.setProperty("--text-body", `${value.fontSizes.chat / 16}rem`);
		root.style.setProperty("--text-code", `${value.fontSizes.code / 16}rem`);
		root.style.setProperty("--inline-code-scale", String(value.fontSizes.code / value.fontSizes.chat));
	}, [value]);
}
