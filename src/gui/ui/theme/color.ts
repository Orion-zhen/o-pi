export type Color = readonly [r: number, g: number, b: number, a: number];
export type Hsl = readonly [h: number, s: number, l: number];

// HEX 在配置或输入边界校验，这里也读取调色板内的固定 RGBA 色值。
export function hex(value: string): Color {
	return [parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255,
		parseInt(value.slice(5, 7), 16) / 255, value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1];
}

export function toHex([r, g, b]: Color): string {
	return `#${[r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export function css([r, g, b, a]: Color): string {
	return `rgb(${(r * 255).toFixed(4)} ${(g * 255).toFixed(4)} ${(b * 255).toFixed(4)} / ${a})`;
}

export function alpha([r, g, b]: Color, a: number): Color { return [r, g, b, a]; }

export function composite([r, g, b, a]: Color, base: Color): Color {
	return [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a), 1];
}

const linear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const srgb = (v: number) => Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));

function oklab([r, g, b]: Color): readonly [number, number, number] {
	const R = linear(r), G = linear(g), B = linear(b);
	const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
	const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
	const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
	return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** 与 OneChat 一致，在 OKLab 空间混色，保留底色透明度。矩阵采用 Björn Ottosson 的 OKLab 定义。 */
export function mix(color: Color, target: Color, amount: number): Color {
	if (amount === 0) return color;
	if (amount === 1) return alpha(target, color[3]);
	const a = oklab(color), b = oklab(target);
	const L = a[0] + (b[0] - a[0]) * amount;
	const A = a[1] + (b[1] - a[1]) * amount;
	const B = a[2] + (b[2] - a[2]) * amount;
	const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
	const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
	const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
	return [srgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		srgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		srgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s), color[3]];
}

function luminance([r, g, b]: Color): number { return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b); }

export function contrast(a: Color, b: Color): number {
	const x = luminance(a), y = luminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function toHsl([r, g, b]: Color): Hsl {
	const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
	const l = (max + min) / 2;
	if (delta === 0) return [0, 0, l * 100];
	const h = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
	return [(h * 60 + 360) % 360, delta / (1 - Math.abs(2 * l - 1)) * 100, l * 100];
}

export function fromHsl([h, s, l]: Hsl): Color {
	const light = l / 100, a = s / 100 * Math.min(light, 1 - light);
	const channel = (n: number) => {
		const k = (n + h / 30) % 12;
		return light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
	};
	return [channel(0), channel(8), channel(4), 1];
}
