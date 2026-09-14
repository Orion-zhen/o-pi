import { VERSION, type Theme } from "@earendil-works/pi-coding-agent";
import type { HomeAnimationFrame } from "./animation.js";
import type { HomePointerFrame } from "./pointer.js";

type SixLines = readonly [string, string, string, string, string, string];
type BrandTheme = Pick<Theme, "fg">;

export const WORDMARK_LINES = [
	" ██████╗     ██████╗ ",
	"██╔═══██╗    ██╔══██╗██╗",
	"██║   ██║    ██████╔╝",
	"██║   ██║    ██╔═══╝ ██║",
	"╚██████╔╝    ██║     ██║",
	" ╚═════╝     ╚═╝     ╚═╝",
] as const satisfies SixLines;
const WORDMARK_WIDTH = Math.max(...WORDMARK_LINES.map((line) => line.length));
const FULL_CORE_TEMPLATE = [
	"A    ╭───────╮    B",
	"─────┤   π   ├─────",
	"D    ╰──┬─┬──╯    C",
	"        │ │",
	"    D───╯ ╰───B",
	"         C",
] as const satisfies SixLines;
const MEDIUM_CORE_TEMPLATE = [
	"A  ╭───╮  B",
	"───┤ π ├───",
	"D  ╰─┬─╯  C",
	"     │",
	"  D──┴──B",
	"     C",
] as const satisfies SixLines;

/** 字标和 Core 只处理绘制，不参与页面布局或定时器调度。 */
export function renderWordmark(theme: BrandTheme, animation: HomeAnimationFrame, pageWidth: number, layout: "full" | "medium"): string[] {
	const revealCount = Math.ceil(Math.max(0, Math.min(1, animation.reveal)) * WORDMARK_LINES.length);
	const brand = buildBrandRows(layout, animation.orbit, animation.pointer);
	const blockWidth = Math.max(...brand.map((row) => row.raw.length));
	return brand.map((row, index) => {
		if (index >= revealCount) return "";
		const pointer = animation.pointer;
		if (pointer !== undefined) {
			const left = Math.max(0, Math.floor((pageWidth - blockWidth) / 2));
			const coreX = left + row.coreStart + Math.floor(row.coreWidth / 2);
			const focusedPointer = pointer.kind === "charge" || pointer.kind === "explode"
				? { ...pointer, x: coreX, y: 2 }
				: pointer;
			return theme.fg(pointerColor(pointer.kind), transformPointerLine(row.raw, index, focusedPointer, pageWidth, blockWidth));
		}
		if (animation.wave < 1) {
			const sweepWidth = blockWidth + WORDMARK_LINES.length * 2;
			const target = Math.round(animation.wave * sweepWidth) - index * 2;
			const highlight = nearestVisibleColumn(row.raw, target);
			if (highlight !== undefined) {
				return `${theme.fg("accent", row.raw.slice(0, highlight))}${theme.fg("mdLink", row.raw.charAt(highlight))}${theme.fg("accent", row.raw.slice(highlight + 1))}`;
			}
		}
		return `${theme.fg("accent", row.logo)}${" ".repeat(row.gap)}${styleCore(theme, row.core)}`.trimEnd();
	});
}

export function renderCompactWordmark(theme: BrandTheme, animation: HomeAnimationFrame): string {
	const label = `O Pi · v${VERSION}`;
	const pointer = animation.pointer;
	if (pointer === undefined) return theme.fg("accent", label);
	const decoration = pointer.kind === "burst" ? "π" : pointer.kind === "explode" ? "*" : pointer.kind === "charge" ? "◉" : "·";
	return theme.fg(pointerColor(pointer.kind), `${decoration} ${label} ${decoration}`);
}

interface BrandRow {
	logo: string;
	gap: number;
	core: string;
	coreStart: number;
	coreWidth: number;
	raw: string;
}

function buildBrandRows(layout: "full" | "medium", orbit: number, pointer: HomePointerFrame | undefined): BrandRow[] {
	const template = layout === "full" ? FULL_CORE_TEMPLATE : MEDIUM_CORE_TEMPLATE;
	const gap = layout === "full" ? 8 : 5;
	const coreLines = renderCore(template, orbit);
	const coreWidth = Math.max(...coreLines.map((line) => line.length));
	const pull = pointer?.kind === "charge" ? Math.min(gap, 1 + Math.floor(pointer.progress * Math.max(1, gap - 1))) : 0;
	const lines: readonly (readonly [string, string])[] = [
		[WORDMARK_LINES[0], coreLines[0]],
		[WORDMARK_LINES[1], coreLines[1]],
		[WORDMARK_LINES[2], coreLines[2]],
		[WORDMARK_LINES[3], coreLines[3]],
		[WORDMARK_LINES[4], coreLines[4]],
		[WORDMARK_LINES[5], coreLines[5]],
	];
	return lines.map(([line, coreLine]) => {
		const logo = `${" ".repeat(pull)}${line.padEnd(WORDMARK_WIDTH, " ")}`;
		const core = coreLine.padEnd(coreWidth, " ");
		const renderedGap = gap - pull;
		return {
			logo,
			gap: renderedGap,
			core,
			coreStart: WORDMARK_WIDTH + gap,
			coreWidth,
			raw: `${logo}${" ".repeat(renderedGap)}${core}`.trimEnd(),
		};
	});
}

function renderCore(template: SixLines, orbit: number): SixLines {
	const phase = Math.abs(Math.floor(orbit)) % 4;
	const marker = (offset: number): string => {
		switch ((phase + offset) % 4) {
			case 0: return "·";
			case 1: return "◦";
			case 2: return "•";
			default: return "◦";
		}
	};
	const renderLine = (line: string): string => line
		.replaceAll("A", marker(0))
		.replaceAll("B", marker(1))
		.replaceAll("C", marker(2))
		.replaceAll("D", marker(3));
	return [renderLine(template[0]), renderLine(template[1]), renderLine(template[2]), renderLine(template[3]), renderLine(template[4]), renderLine(template[5])];
}

function styleCore(theme: BrandTheme, core: string): string {
	return core.split(/([π·◦•])/u).map((part) => {
		if (part === "π") return theme.fg("mdLink", part);
		if (part === "·" || part === "◦" || part === "•") return theme.fg("accent", part);
		return part.length === 0 ? part : theme.fg("dim", part);
	}).join("");
}

function transformPointerLine(line: string, row: number, frame: HomePointerFrame, pageWidth: number, blockWidth: number): string {
	const left = Math.max(0, Math.floor((pageWidth - blockWidth) / 2));
	const originX = Math.max(0, Math.min(blockWidth - 1, frame.x - left));
	const originY = frame.kind === "charge" || frame.kind === "explode"
		? Math.max(0, Math.min(WORDMARK_LINES.length - 1, frame.y))
		: Math.abs(frame.y) % WORDMARK_LINES.length;
	return Array.from(line.padEnd(blockWidth, " "), (char, column) => {
		const distance = Math.hypot(column - originX, (row - originY) * 1.8);
		const noise = pointerNoise(row, column, frame.x + frame.y * 31);
		if (frame.kind === "press") {
			const radius = 2 + frame.progress * 5;
			if (distance <= radius && char === " " && noise > 0.64) return "·";
			if (distance <= 1.6 && char !== " ") return "▓";
			return char;
		}
		if (frame.kind === "charge") {
			const radius = 5 + frame.progress * 6;
			if (distance <= radius && char === " " && noise > 0.42) return noise > 0.84 ? "π" : "·";
			if (distance <= radius * 0.55 && char !== " " && noise > 0.68) return "▓";
			return char;
		}
		const radius = frame.progress * (blockWidth + 8);
		const ring = Math.abs(distance - radius);
		if (frame.kind === "ripple") {
			if (ring > 1.6) return char;
			return char === " " ? noise > 0.7 ? "*" : "·" : "▓";
		}
		if (frame.kind === "burst") {
			if (ring > 3.2 || noise < 0.24) return char;
			if (char !== " ") return noise > 0.8 ? "π" : "▓";
			return noise > 0.76 ? "π" : noise > 0.48 ? "*" : "·";
		}
		if (ring <= 3.2) {
			if (char === " ") return noise > 0.72 ? "π" : "*";
			return noise > 0.52 ? " " : "▓";
		}
		if (frame.progress < 0.55 && distance < radius && char !== " " && noise > 0.72) return " ";
		return char;
	}).join("").trimEnd();
}

function pointerNoise(row: number, column: number, seed: number): number {
	let value = Math.imul(row + 17, 0x45d9f3b) ^ Math.imul(column + 31, 0x119de1f3) ^ seed;
	value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
	value ^= value >>> 16;
	return (value >>> 0) / 0xffff_ffff;
}

function pointerColor(kind: HomePointerFrame["kind"]): Parameters<Theme["fg"]>[0] {
	if (kind === "charge" || kind === "explode") return "warning";
	if (kind === "burst") return "mdLink";
	return "accent";
}

function nearestVisibleColumn(line: string, target: number): number | undefined {
	if (target < -2 || target >= line.length + 2) return undefined;
	for (let distance = 0; distance < line.length; distance += 1) {
		const right = target + distance;
		if (right >= 0 && right < line.length && line[right] !== " ") return right;
		const left = target - distance;
		if (left >= 0 && left < line.length && line[left] !== " ") return left;
	}
	return undefined;
}
