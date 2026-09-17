import { alpha, composite, contrast, hex, mix, type Color } from "./color.ts";

export const DEFAULT_THEME_COLOR = "#007AFF";
const black = hex("#000000"), white = hex("#FFFFFF");

function readable(seed: Color, backgrounds: readonly Color[], dark: boolean, minimum = 4.5): Color {
	const target = dark ? white : black;
	for (let step = 0; step <= 20; step++) {
		const color = mix(seed, target, step / 20);
		if (backgrounds.every((background) => contrast(color, background) >= minimum)) return color;
	}
	return target;
}

function onColor(background: Color): Color {
	return contrast(black, background) >= contrast(white, background) ? black : white;
}

// 白色主题、黑色主题也需要交互反馈，并保持实心按钮文字的对比度。
function interaction(color: Color, foreground: Color, target: Color, amount: number): Color {
	const toward = contrast(color, target) < 1.01 ? (target === white ? black : white) : target;
	for (let step = 10; step > 0; step--) {
		const candidate = mix(color, toward, amount * step / 10);
		if (contrast(candidate, foreground) >= 4.5) return candidate;
	}
	return color;
}

/** 从 OneChat 的 AppPalette 移植。浏览器画布和遮挡文字的列表底色使用不透明颜色。 */
export function generatePalette(mode: "light" | "dark", themeColor: string) {
	const dark = mode === "dark", seed = hex(themeColor);
	const tint = dark ? 0.025 : 0.012;
	const background = mix(hex(dark ? "#18181A" : "#F5F5F7"), seed, tint * 0.5);
	const panel = mix(hex(dark ? "#2C2C2E" : "#FFFFFF"), seed, tint);
	const sidebar = mix(hex(dark ? "#242426DC" : "#EBEBF0DC"), seed, tint);
	const toolbar = mix(hex(dark ? "#1D1D1FDC" : "#F7F7F8DC"), seed, tint * 0.7);
	const foreground = hex(dark ? "#F5F5F7" : "#1D1D1F");
	const secondary = composite(hex(dark ? "#FFFFFF10" : "#3C3C4324"), background);
	const hover = composite(hex(dark ? "#FFFFFF20" : "#3C3C4330"), dark ? panel : background);
	const active = composite(hex(dark ? "#FFFFFF30" : "#3C3C4340"), dark ? panel : background);
	const surfaces = [background, panel, composite(sidebar, background), hover, secondary, ...(dark ? [active] : [])];
	const primary = readable(seed, [background], dark);
	const primaryForeground = onColor(primary);
	const userBackground = mix(panel, primary, dark ? 0.22 : 0.09);
	const userLink = readable(seed, [userBackground], dark);
	const muted = readable(hex(dark ? "#A1A1AA" : "#48484A"), surfaces, dark);
	const danger = readable(hex(dark ? "#FF453A" : "#D70015"), surfaces, dark);
	const success = readable(hex(dark ? "#30D158" : "#248A3D"), surfaces, dark);
	const warning = readable(hex(dark ? "#FFCC00" : "#936B22"), surfaces, dark);
	const dangerForeground = onColor(danger);
	const scrollbarBackgrounds = [...surfaces, userBackground];
	const scrollbar = (minimum: number) => readable(mix(background, primary, 0.04), scrollbarBackgrounds, dark, minimum);

	return {
		background, foreground,
		primary, "primary-foreground": primaryForeground,
		"primary-hover": interaction(primary, primaryForeground, white, 0.07),
		"primary-active": interaction(primary, primaryForeground, black, 0.1),
		secondary, "secondary-hover": hover, "secondary-active": active,
		accent: hover, selected: secondary,
		popover: alpha(panel, 0.95), surface: alpha(panel, 0.96), glass: sidebar, toolbar,
		"muted-foreground": muted,
		border: hex(dark ? "#FFFFFF16" : "#3C3C4330"), ring: primary,
		link: primary, emphasis: mix(foreground, primary, dark ? 0.3 : 0.22),
		selection: alpha(primary, dark ? 0.32 : 0.22),
		destructive: danger, "destructive-foreground": dangerForeground,
		"destructive-hover": interaction(danger, dangerForeground, white, 0.07),
		"destructive-active": interaction(danger, dangerForeground, black, 0.1),
		"danger-soft": alpha(danger, dark ? 0.14 : 0.095), success, warning,
		"git-added": success, "git-deleted": danger, "git-modified": warning,
		overlay: hex(dark ? "#00000088" : "#00000066"),
		"floating-shadow": hex(dark ? "#0000005C" : "#1D1D1F24"),
		"surface-shine": hex(dark ? "#FFFFFF08" : "#FFFFFF80"),
		"control-thumb": white,
		"scrollbar-thumb": scrollbar(3), "scrollbar-thumb-hover": scrollbar(4.5), "scrollbar-thumb-active": scrollbar(6),
		"user-background": userBackground, "user-foreground": foreground,
		"user-muted-foreground": readable(mix(muted, primary, dark ? 0.08 : 0.06), [userBackground], dark),
		"user-link": userLink, "user-emphasis": mix(foreground, userLink, dark ? 0.35 : 0.24),
		"user-border": alpha(primary, dark ? 0.18 : 0.14),
		"user-surface": composite(alpha(white, dark ? 0.08 : 0.44), userBackground),
		"user-selection": alpha(primary, dark ? 0.22 : 0.18),
		"syntax-keyword": hex(dark ? "#CE9AC5" : "#925080"),
		"syntax-string": hex(dark ? "#A1C39B" : "#39784D"),
		"syntax-function": hex(dark ? "#98BBD9" : "#396B9A"),
		"syntax-number": hex(dark ? "#D6B087" : "#9A603A"),
	};
}
