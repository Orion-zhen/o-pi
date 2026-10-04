import { expect, it } from "vitest";
import { generatePalette } from "../../src/gui/ui/preferences/palette.ts";
import { alpha, composite, contrast, hex } from "../../src/gui/ui/preferences/color.ts";
import { readGuiDefaults } from "../../src/gui/host/preferences.ts";

for (const mode of ["light", "dark"] as const) {
	it.each(["#007AFF", "#AF52DE", "#FFFFFF", "#000000"])(`${mode} 主题色 %s 保持文字对比度与独立交互状态`, (seed) => {
		const palette = generatePalette(mode, seed);
		expect(palette.accent).not.toEqual(palette.selected);
		expect(palette.accent).not.toEqual(palette["secondary-active"]);
		expect(contrast(palette.primary, palette.background)).toBeGreaterThanOrEqual(4.5);
		for (const key of ["primary", "primary-hover", "primary-active"] as const)
			expect(contrast(palette[key], palette["primary-foreground"]), key).toBeGreaterThanOrEqual(4.5);
		for (const surface of ["background", "panel-base", "canvas-base", "glass-base", "control-base", "soft-base", "accent"] as const) {
			for (const text of ["foreground", "muted-foreground", "destructive", "success", "warning"] as const)
				expect(contrast(palette[text], palette[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
		}
		expect(contrast(palette["user-foreground"], palette["user-background"])).toBeGreaterThanOrEqual(4.5);
		expect(contrast(palette["user-link"], palette["user-background"])).toBeGreaterThanOrEqual(4.5);
	});
}

it.each(["#1D2431", "#B7C2D6"])("默认深色材质覆盖深蓝灰和银灰背景 %s 时保持正文对比度", (backdrop) => {
	const palette = generatePalette("dark", "#007AFF");
	const { materials } = readGuiDefaults();
	for (const [base, opacity] of [[palette["canvas-base"], materials.canvas.darkOpacity], [palette["glass-base"], materials.inspector.darkOpacity]] as const) {
		const surface = composite(alpha(base, opacity / 100), hex(backdrop));
		for (const text of ["foreground", "muted-foreground", "success", "warning", "destructive"] as const)
			expect(contrast(palette[text], surface), text).toBeGreaterThanOrEqual(4.5);
	}
});
