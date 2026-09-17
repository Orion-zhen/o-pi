import { useLayoutEffect } from "react";
import type { GuiPreferences } from "../preferences.ts";
import { applyThemeColor } from "./theme/apply.ts";

export function fontFamily(font: string, kind: "ui" | "code"): string {
	const fallback = kind === "ui" ? "system-ui, sans-serif" : "ui-monospace, monospace";
	return font === "system-ui" || font === "monospace" ? fallback : `${JSON.stringify(font)}, ${fallback}`;
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
