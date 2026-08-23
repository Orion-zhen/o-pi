import { VERSION, type ReadonlyFooterDataProvider, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatCapabilitySummary, summarizeCapabilityGroups } from "./capabilities.js";
import { formatTokens, formatWorkspace } from "./footer.js";
import type { HomePointerFrame } from "./home-pointer.js";
import { joinParts } from "./text.js";
import type { TuiFooterSnapshot, TuiHomeConfig } from "./types.js";

type SixLines = readonly [string, string, string, string, string, string];

const WORDMARK_LINES = [
	" ██████╗     ██████╗",
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
const FULL_CONTENT_WIDTH = 88;
const MEDIUM_MIN_WIDTH = 56;
const FULL_MIN_WIDTH = 96;
const FULL_MIN_HEIGHT = 20;
const MEDIUM_MIN_HEIGHT = 13;
const CONTEXT_BAR_WIDTH = 10;
const HOME_HINTS = "/ commands   /tools   /stats   @ files   ! shell";
const NARROW_HOME_HINTS = "/ commands · @ files · ! shell";

const HOME_TIPS = [
	"Use @ to attach files to the prompt.",
	"Use ! to run a shell command without leaving the editor.",
	"Use /agents to delegate focused work.",
	"Use /tools to review the active tool set.",
	"Press Ctrl+O to expand tool and thinking details.",
] as const;

export interface HomeAnimationFrame {
	reveal: number;
	wave: number;
	orbit?: number;
	pointer?: HomePointerFrame;
}

export interface HomePageOptions {
	height: number;
	tip: string;
	animation: HomeAnimationFrame;
}

type HomeLayout = "full" | "medium" | "compact";
type HomeTheme = Pick<Theme, "fg">;

/** 渲染以输入框为中心的启动 Home；信息不足时隐藏字段，不输出占位脏值。 */
export function formatHomePage(
	snapshot: TuiFooterSnapshot,
	config: TuiHomeConfig,
	width: number,
	editorLines: readonly string[],
	theme: HomeTheme,
	options: HomePageOptions,
): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const targetHeight = Math.max(editorLines.length, Math.floor(options.height));
	const preferred = resolveLayout(safeWidth, targetHeight);
	const candidates = preferred === "full" ? ["full", "medium", "compact"] as const
		: preferred === "medium" ? ["medium", "compact"] as const
			: ["compact"] as const;
	let content = buildLayout(candidates[0], snapshot, config, safeWidth, editorLines, theme, options.tip, options.animation);
	for (const layout of candidates.slice(1)) {
		if (content.length <= targetHeight) break;
		content = buildLayout(layout, snapshot, config, safeWidth, editorLines, theme, options.tip, options.animation);
	}
	if (content.length > targetHeight) {
		content = editorLines.map((line) => centerLine(truncateToWidth(line, Math.min(safeWidth, FULL_CONTENT_WIDTH), "…"), safeWidth));
	}
	if (content.length === targetHeight) return content;
	const freeRows = targetHeight - content.length;
	const top = Math.floor(freeRows / 2);
	return [...Array.from({ length: top }, () => ""), ...content, ...Array.from({ length: freeRows - top }, () => "")];
}

/** Home 模式 footer 只保留操作入口和版本，避免重复中央信息面板。 */
export function formatHomeFooter(config: TuiHomeConfig, width: number, theme: HomeTheme): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const hints = !config.show_hints ? "" : color(theme, "dim", safeWidth >= 64 ? HOME_HINTS : safeWidth >= 32 ? NARROW_HOME_HINTS : "/ commands");
	const version = color(theme, "dim", `O Pi v${VERSION}`);
	return [alignLine(hints, version, safeWidth)];
}

export function createHomeHeaderComponent(): (_tui: TUI, _theme: Theme) => Component {
	return () => ({ render: () => [], invalidate() {} });
}

export function createHomeFooterComponent(
	config: TuiHomeConfig,
	bindFooterData: (footerData: ReadonlyFooterDataProvider) => void,
): (tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose(): void } {
	return (tui, theme, footerData) => {
		let unsubscribe = (): void => {};
		const component: Component & { dispose(): void } = {
			render: (width) => formatHomeFooter(config, width, theme),
			invalidate() {},
			dispose() {
				unsubscribe();
				unsubscribe = () => {};
			},
		};
		bindFooterData(footerData);
		unsubscribe = footerData.onBranchChange(() => {
			bindFooterData(footerData);
			component.invalidate();
			tui.requestRender();
		});
		return component;
	};
}

/** 同一 session 稳定选择一条提示，测试和重绘不会发生随机跳动。 */
export function selectHomeTip(seed: string): string {
	let hash = 0;
	for (const char of seed) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
	switch (hash % HOME_TIPS.length) {
		case 0: return HOME_TIPS[0];
		case 1: return HOME_TIPS[1];
		case 2: return HOME_TIPS[2];
		case 3: return HOME_TIPS[3];
		default: return HOME_TIPS[4];
	}
}

function resolveLayout(width: number, height: number): HomeLayout {
	if (width >= FULL_MIN_WIDTH && height >= FULL_MIN_HEIGHT) return "full";
	if (width >= MEDIUM_MIN_WIDTH && height >= MEDIUM_MIN_HEIGHT) return "medium";
	return "compact";
}

function buildLayout(
	layout: HomeLayout,
	snapshot: TuiFooterSnapshot,
	config: TuiHomeConfig,
	width: number,
	editorLines: readonly string[],
	theme: HomeTheme,
	tip: string,
	animation: HomeAnimationFrame,
): string[] {
	const contentWidth = Math.min(width, layout === "compact" ? width : FULL_CONTENT_WIDTH);
	const center = (line: string): string => centerLine(truncateToWidth(line, contentWidth, "…"), width);
	const block = (line: string): string => line.length === 0 ? "" : placeBlock(truncateToWidth(line, contentWidth, "…"), width, contentWidth);
	const logo = layout === "compact"
		? [center(renderCompactWordmark(theme, animation))]
		: centerBlockLines(renderWordmark(theme, animation, width, layout), width);
	const tagline = config.show_tagline && layout !== "compact"
		? [center(color(theme, "dim", "make something different"))]
		: [];
	const framedEditor = editorLines.map(center);
	const info = layout === "full"
		? renderFullInfo(snapshot, config, contentWidth, theme).map(block)
		: layout === "medium"
			? renderMediumInfo(snapshot, config, contentWidth, theme).map(block)
			: renderCompactInfo(snapshot, contentWidth, theme).map(block);
	const tipLine = config.show_tips && layout !== "compact"
		? [center(joinParts([color(theme, "accent", "● Tip"), color(theme, "dim", tip)], "  "))]
		: [];
	return joinSections([logo, tagline, framedEditor, info, tipLine]);
}

function renderFullInfo(snapshot: TuiFooterSnapshot, config: TuiHomeConfig, width: number, theme: HomeTheme): string[] {
	const panels = [
		{ label: "PROJECT", value: formatProject(snapshot, theme) },
		{ label: "CONTEXT", value: formatContextPanel(snapshot, theme, true) },
	].filter((panel): panel is { label: string; value: string } => panel.value !== undefined);
	const lines: string[] = [];
	if (panels.length === 1) {
		const panel = panels[0];
		if (panel !== undefined) lines.push(color(theme, "dim", panel.label), panel.value);
	} else if (panels.length >= 2) {
		const gap = 6;
		const columnWidth = Math.max(1, Math.floor((width - gap) / 2));
		const left = panels[0];
		const right = panels[1];
		if (left !== undefined && right !== undefined) {
			lines.push(
				columns(color(theme, "dim", left.label), color(theme, "dim", right.label), columnWidth, gap, width),
				columns(left.value, right.value, columnWidth, gap, width),
			);
		}
	}
	const capabilityLines = formatCapabilities(snapshot, config, width, theme);
	if (capabilityLines.length > 0) lines.push(...(lines.length > 0 ? [""] : []), color(theme, "dim", "CAPABILITIES"), ...capabilityLines);
	return lines;
}

function renderMediumInfo(snapshot: TuiFooterSnapshot, config: TuiHomeConfig, width: number, theme: HomeTheme): string[] {
	const project = formatProject(snapshot, theme);
	const context = formatContextPanel(snapshot, theme, false);
	const counts = formatCapabilityCounts(snapshot, theme);
	const summary = config.show_capabilities
		? formatCapabilitySummary(summarizeCapabilityGroups(snapshot.tools), width, theme)
		: undefined;
	return [project, joinParts([context, counts], color(theme, "dim", " · ")), summary]
		.filter((line): line is string => line !== undefined && line.length > 0);
}

function renderCompactInfo(snapshot: TuiFooterSnapshot, width: number, theme: HomeTheme): string[] {
	const project = formatProject(snapshot, theme);
	const context = formatCompactContext(snapshot, theme);
	const counts = formatCapabilityCounts(snapshot, theme);
	return [project, joinParts([context, counts], color(theme, "dim", " · "))]
		.filter((line): line is string => line !== undefined && line.length > 0)
		.map((line) => truncateToWidth(line, width, "…"));
}

function formatProject(snapshot: TuiFooterSnapshot, theme: HomeTheme): string | undefined {
	if (!snapshot.cwd) return undefined;
	const workspace = color(theme, "accent", formatWorkspace(snapshot.cwd));
	if (!snapshot.git) return workspace;
	return joinParts([
		workspace,
		color(theme, "success", snapshot.git),
	], color(theme, "dim", " · "));
}

function formatContextPanel(snapshot: TuiFooterSnapshot, theme: HomeTheme, showBar: boolean): string | undefined {
	const usage = snapshot.context;
	if (usage === undefined) return undefined;
	const tokens = usage.tokens === null ? "?" : formatTokens(usage.tokens);
	const window = formatTokens(Math.max(0, usage.contextWindow));
	const percent = usage.percent === null ? undefined : Math.max(0, Math.min(100, usage.percent));
	const value = `${tokens} / ${window}`;
	if (percent === undefined) return joinParts([color(theme, "muted", value), color(theme, "muted", "?%")], color(theme, "dim", "  "));
	const percentText = `${Math.round(percent)}%`;
	if (!showBar) return joinParts([contextColor(theme, value, percent), contextColor(theme, percentText, percent)], color(theme, "dim", " · "));
	const filled = Math.round((percent / 100) * CONTEXT_BAR_WIDTH);
	const bar = `${"█".repeat(filled)}${"░".repeat(CONTEXT_BAR_WIDTH - filled)}`;
	return joinParts([contextColor(theme, value, percent), contextColor(theme, bar, percent), contextColor(theme, percentText, percent)], "  ");
}

function formatCompactContext(snapshot: TuiFooterSnapshot, theme: HomeTheme): string | undefined {
	const usage = snapshot.context;
	if (usage === undefined) return undefined;
	if (usage.percent === null) return color(theme, "muted", "ctx ?%");
	const percent = Math.max(0, Math.min(100, usage.percent));
	return contextColor(theme, `ctx ${Math.round(percent)}%`, percent);
}

function formatCapabilities(snapshot: TuiFooterSnapshot, config: TuiHomeConfig, width: number, theme: HomeTheme): string[] {
	const counts = formatCapabilityCounts(snapshot, theme);
	const summary = config.show_capabilities
		? formatCapabilitySummary(summarizeCapabilityGroups(snapshot.tools), width, theme)
		: undefined;
	return [counts, summary].filter((line): line is string => line !== undefined && line.length > 0);
}

function formatCapabilityCounts(snapshot: TuiFooterSnapshot, theme: HomeTheme): string | undefined {
	const tools = snapshot.tools;
	const skills = snapshot.skills;
	const parts: Array<string | undefined> = [];
	if (tools !== undefined) {
		const active = tools.activeNames.length;
		parts.push(color(theme, active === tools.totalCount ? "success" : "warning", `${active}/${tools.totalCount} tools`));
	}
	if (skills !== undefined) {
		parts.push(color(theme, "success", `${skills.totalCount} skills`));
		parts.push(color(theme, "text", `${skills.modelInvocableCount} model-invocable`));
	}
	return joinParts(parts, color(theme, "dim", " · ")) || undefined;
}

function renderWordmark(
	theme: HomeTheme,
	animation: HomeAnimationFrame,
	pageWidth: number,
	layout: Exclude<HomeLayout, "compact">,
): string[] {
	const revealCount = Math.ceil(Math.max(0, Math.min(1, animation.reveal)) * WORDMARK_LINES.length);
	const brand = buildBrandRows(layout, animation.orbit ?? 0, animation.pointer);
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
			return color(
				theme,
				pointerColor(pointer.kind),
				transformPointerLine(row.raw, index, focusedPointer, pageWidth, blockWidth),
			);
		}
		if (animation.wave < 1) {
			const sweepWidth = blockWidth + WORDMARK_LINES.length * 2;
			const target = Math.round(animation.wave * sweepWidth) - index * 2;
			const highlight = nearestVisibleColumn(row.raw, target);
			if (highlight !== undefined) {
				return `${color(theme, "accent", row.raw.slice(0, highlight))}${color(theme, "mdLink", row.raw.charAt(highlight))}${color(theme, "accent", row.raw.slice(highlight + 1))}`;
			}
		}
		return `${color(theme, "accent", row.logo)}${" ".repeat(row.gap)}${styleCore(theme, row.core)}`.trimEnd();
	});
}

interface BrandRow {
	logo: string;
	gap: number;
	core: string;
	coreStart: number;
	coreWidth: number;
	raw: string;
}

function buildBrandRows(
	layout: Exclude<HomeLayout, "compact">,
	orbit: number,
	pointer: HomePointerFrame | undefined,
): BrandRow[] {
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
		const logo = line.padEnd(WORDMARK_WIDTH, " ");
		const core = coreLine.padEnd(coreWidth, " ");
		const renderedLogo = `${" ".repeat(pull)}${logo}`;
		const renderedGap = Math.max(0, gap - pull);
		return {
			logo: renderedLogo,
			gap: renderedGap,
			core,
			coreStart: WORDMARK_WIDTH + gap,
			coreWidth,
			raw: `${renderedLogo}${" ".repeat(renderedGap)}${core}`.trimEnd(),
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
	return [
		renderLine(template[0]),
		renderLine(template[1]),
		renderLine(template[2]),
		renderLine(template[3]),
		renderLine(template[4]),
		renderLine(template[5]),
	];
}

function styleCore(theme: HomeTheme, core: string): string {
	return core.split(/([π·◦•])/u).map((part) => {
		if (part === "π") return color(theme, "mdLink", part);
		if (part === "·" || part === "◦" || part === "•") return color(theme, "accent", part);
		return color(theme, "dim", part);
	}).join("");
}

function renderCompactWordmark(theme: HomeTheme, animation: HomeAnimationFrame): string {
	const label = `O Pi · v${VERSION}`;
	const pointer = animation.pointer;
	if (pointer === undefined) return color(theme, "accent", label);
	const decoration = pointer.kind === "burst" ? "π" : pointer.kind === "explode" ? "*" : pointer.kind === "charge" ? "◉" : "·";
	return color(theme, pointerColor(pointer.kind), `${decoration} ${label} ${decoration}`);
}

function transformPointerLine(
	line: string,
	row: number,
	frame: HomePointerFrame,
	pageWidth: number,
	blockWidth: number,
): string {
	const left = Math.max(0, Math.floor((pageWidth - blockWidth) / 2));
	const originX = Math.max(0, Math.min(blockWidth - 1, frame.x - left));
	const originY = frame.kind === "charge" || frame.kind === "explode"
		? Math.max(0, Math.min(WORDMARK_LINES.length - 1, frame.y))
		: Math.abs(frame.y) % WORDMARK_LINES.length;
	const padded = line.padEnd(blockWidth, " ");
	return Array.from(padded, (char, column) => {
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

function columns(left: string, right: string, columnWidth: number, gap: number, width: number): string {
	const fittedLeft = truncateToWidth(left, columnWidth, "…");
	const fittedRight = truncateToWidth(right, columnWidth, "…");
	return truncateToWidth(`${fittedLeft}${" ".repeat(Math.max(gap, columnWidth - visibleWidth(fittedLeft) + gap))}${fittedRight}`, width, "…");
}

function joinSections(sections: readonly string[][]): string[] {
	const nonEmpty = sections.filter((section) => section.length > 0);
	return nonEmpty.flatMap((section, index) => index === 0 ? section : ["", ...section]);
}

function centerLine(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "…");
	return `${" ".repeat(Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2)))}${clipped}`;
}

function centerBlockLines(lines: readonly string[], width: number): string[] {
	const blockWidth = Math.min(width, Math.max(0, ...lines.map(visibleWidth)));
	const left = Math.max(0, Math.floor((width - blockWidth) / 2));
	return lines.map((line) => line.length === 0 ? "" : `${" ".repeat(left)}${truncateToWidth(line, blockWidth, "…")}`);
}

function placeBlock(text: string, width: number, blockWidth: number): string {
	const left = Math.max(0, Math.floor((width - Math.min(width, blockWidth)) / 2));
	return `${" ".repeat(left)}${truncateToWidth(text, Math.max(1, width - left), "…")}`;
}

function alignLine(left: string, right: string, width: number): string {
	if (left.length === 0) return truncateToWidth(right, width, "…");
	if (right.length === 0) return truncateToWidth(left, width, "…");
	const fittedRight = truncateToWidth(right, width, "…");
	const rightWidth = visibleWidth(fittedRight);
	if (rightWidth >= width - 1) return fittedRight;
	const leftBudget = Math.max(1, width - rightWidth - 1);
	const fittedLeft = truncateToWidth(left, leftBudget, "…");
	const gap = Math.max(1, width - visibleWidth(fittedLeft) - rightWidth);
	return `${fittedLeft}${" ".repeat(gap)}${fittedRight}`;
}

function contextColor(theme: HomeTheme, text: string, percent: number): string {
	return color(theme, percent >= 85 ? "error" : percent >= 60 ? "warning" : "success", text);
}

function color(theme: HomeTheme, name: Parameters<Theme["fg"]>[0], text: string): string {
	return text.length === 0 ? text : theme.fg(name, text);
}
