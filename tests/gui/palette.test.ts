import { expect, it } from "vitest";
import { composite, contrast, fromHsl, hex, toHex, toHsl } from "../../src/gui/ui/theme/color.ts";
import { generatePalette } from "../../src/gui/ui/theme/palette.ts";

const seeds = ["#007AFF", "#FFCC00", "#34C759", "#AF52DE", "#A9B8C7", "#808080", "#FFFFFF", "#000000"];

it.each(["light", "dark"] as const)("%s：主题色派生的文字、按钮和滚动条可读", (mode) => {
	for (const seed of seeds) {
		const p = generatePalette(mode, seed);
		for (const surface of [p.background, composite(p.surface, p.background), composite(p.glass, p.background), p.secondary, p.accent]) {
			for (const text of [p.foreground, p["muted-foreground"], p.success, p.warning, p.destructive]) {
				expect(contrast(text, surface), `${mode} ${seed} 文字对比度`).toBeGreaterThanOrEqual(4.5);
			}
		}
		for (const [text, surface] of [
			[p.primary, p.background], [p.link, p.background], [p.emphasis, p.background],
			[p["user-foreground"], p["user-background"]], [p["user-muted-foreground"], p["user-background"]], [p["user-link"], p["user-background"]],
			[p["primary-foreground"], p.primary], [p["primary-foreground"], p["primary-hover"]], [p["primary-foreground"], p["primary-active"]],
			[p["destructive-foreground"], p.destructive], [p["destructive-foreground"], p["destructive-hover"]], [p["destructive-foreground"], p["destructive-active"]],
		] as const) expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
		for (const surface of [p.background, composite(p.surface, p.background), p["user-background"]]) {
			expect(contrast(p["scrollbar-thumb"], surface)).toBeGreaterThanOrEqual(3);
			expect(contrast(p["scrollbar-thumb-hover"], surface)).toBeGreaterThanOrEqual(4.5);
			expect(contrast(p["scrollbar-thumb-active"], surface)).toBeGreaterThanOrEqual(6);
		}
		expect(p["primary-hover"]).not.toEqual(p.primary);
		expect(p["primary-active"]).not.toEqual(p.primary);
		expect(p["secondary-hover"]).not.toEqual(p.secondary);
		expect(p["secondary-active"]).not.toEqual(p["secondary-hover"]);
	}
});

it.each([
	["light", "#0069DE", "#202E45"],
	["dark", "#1F82FF", "#BAD5FD"],
] as const)("%s：默认蓝色主色与消息配色与 OneChat 一致", (mode, link, emphasis) => {
	const p = generatePalette(mode, "#007AFF");
	expect(toHex(p.link)).toBe(link);
	expect(toHex(p.emphasis)).toBe(emphasis);
	expect(p.link).toEqual(p.primary);
});

it.each(seeds)("深色主题 %s 的按钮和菜单高亮在面板上清晰可见", (seed) => {
	const p = generatePalette("dark", seed);
	for (const surface of [p.background, composite(p.surface, p.background), composite(p.popover, p.background), composite(p.glass, p.background), p.secondary]) {
		expect(contrast(p.accent, surface)).toBeGreaterThanOrEqual(1.4);
		expect(contrast(p["secondary-active"], surface)).toBeGreaterThan(contrast(p.accent, surface));
	}
	expect(contrast(p["secondary-active"], p["secondary-hover"])).toBeGreaterThanOrEqual(1.2);
	for (const surface of [p.accent, p["secondary-hover"], p["secondary-active"]]) {
		for (const text of [p.foreground, p["muted-foreground"]]) {
			expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
		}
	}
});

it("改变主题色会改变表面和消息气泡，不把灰蓝主题变成高饱和色", () => {
	for (const mode of ["light", "dark"] as const) {
		const blue = generatePalette(mode, "#007AFF"), pink = generatePalette(mode, "#FF2D55");
		for (const token of ["background", "glass", "surface", "primary", "user-background", "link", "selection"] as const)
			expect(blue[token]).not.toEqual(pink[token]);
		expect(toHsl(generatePalette(mode, "#A9B8C7").primary)[1]).toBeLessThan(55);
	}
});

it.each(seeds)("主题色 %s 在 HEX 与 HSL 控件之间转换保持原色", (seed) => {
	expect(toHex(fromHsl(toHsl(hex(seed))))).toBe(seed);
});
