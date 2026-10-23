import { css } from "./color.ts";
import { generatePalette } from "./palette.ts";

export function applyThemeColor(seed: string): void {
	const light = generatePalette("light", seed), dark = generatePalette("dark", seed);
	for (const name of Object.keys(light) as (keyof typeof light)[]) {
		document.documentElement.style.setProperty(`--${name}`, `light-dark(${css(light[name])}, ${css(dark[name])})`);
	}
}
