import { nativeTheme, type BrowserWindow } from "electron";
import { release } from "node:os";
import type { DesktopAppearance, DesktopMaterial } from "../gui/contract.ts";
import { GUI_BACKGROUNDS } from "../gui/theme-base.ts";

function parseAppearance(value: unknown): DesktopAppearance {
	if (typeof value !== "object" || value === null || !("theme" in value) || !("transparent" in value)
		|| (value.theme !== "system" && value.theme !== "light" && value.theme !== "dark") || typeof value.transparent !== "boolean")
		throw new Error("无效窗口外观");
	return { theme: value.theme, transparent: value.transparent };
}

export function installDesktopAppearance(window: BrowserWindow): (value: unknown) => DesktopMaterial {
	const material = process.platform === "darwin" ? "vibrancy"
		: process.platform === "linux" ? "compositor"
		: process.platform === "win32" && Number(release().split(".")[2]) >= 22621 ? "acrylic" : "none";
	let transparent = false;
	const update = () => {
		const enabled = transparent && !nativeTheme.prefersReducedTransparency && !nativeTheme.shouldUseHighContrastColors;
		if (material === "vibrancy") window.setVibrancy(enabled ? "hud" : null);
		if (material === "acrylic") window.setBackgroundMaterial(enabled ? "acrylic" : "none");
		window.setBackgroundColor(enabled && material !== "none" ? "#00000000" : GUI_BACKGROUNDS[nativeTheme.shouldUseDarkColors ? "dark" : "light"]);
	};
	nativeTheme.on("updated", update);
	window.once("closed", () => nativeTheme.off("updated", update));
	return (value) => {
		const appearance = parseAppearance(value);
		transparent = appearance.transparent;
		nativeTheme.themeSource = appearance.theme;
		update();
		return material;
	};
}
