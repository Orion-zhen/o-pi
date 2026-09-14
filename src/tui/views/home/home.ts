import { VERSION, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderCompactWordmark, renderWordmark } from "./brand.ts";
import { formatCapabilitySummary, summarizeCapabilityGroups } from "./capabilities.ts";
import { formatProject, formatTokens } from "../../components/format.ts";
import type { HomeAnimationFrame } from "./animation.ts";
import { joinParts } from "../../components/text.ts";
import type { TuiSnapshot, TuiHomeConfig } from "../../shell/types.ts";

export const HOME_CONTENT_WIDTH = 88;
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

interface HomePageOptions {
	height: number;
	tip: string;
	animation: HomeAnimationFrame;
}

type HomeLayout = "full" | "medium" | "compact";
type HomeTheme = Pick<Theme, "fg">;

/** 依次缩减布局，空间不足时优先保留完整输入框。 */
export function formatHomePage(
	snapshot: TuiSnapshot,
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
		: preferred === "medium" ? ["medium", "compact"] as const : ["compact"] as const;
	let content = buildLayout(candidates[0], snapshot, config, safeWidth, editorLines, theme, options);
	for (const layout of candidates.slice(1)) {
		if (content.length <= targetHeight) break;
		content = buildLayout(layout, snapshot, config, safeWidth, editorLines, theme, options);
	}
	if (content.length > targetHeight) {
		content = editorLines.map((line) => centerLine(truncateToWidth(line, Math.min(safeWidth, HOME_CONTENT_WIDTH), "…"), safeWidth));
	}
	const freeRows = targetHeight - content.length;
	const top = Math.floor(freeRows / 2);
	return [...Array<string>(top).fill(""), ...content, ...Array<string>(freeRows - top).fill("")];
}

/** Home 页脚只保留操作入口和版本。 */
export function formatHomeFooter(config: TuiHomeConfig, width: number, theme: HomeTheme): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const hints = !config.show_hints ? "" : color(theme, "dim", safeWidth >= 64 ? HOME_HINTS : safeWidth >= 32 ? NARROW_HOME_HINTS : "/ commands");
	return [alignLine(hints, color(theme, "dim", `O Pi v${VERSION}`), safeWidth)];
}

/** 同一会话稳定选择提示，重绘不会随机跳动。 */
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
	snapshot: TuiSnapshot,
	config: TuiHomeConfig,
	width: number,
	editorLines: readonly string[],
	theme: HomeTheme,
	{ tip, animation }: HomePageOptions,
): string[] {
	const contentWidth = Math.min(width, layout === "compact" ? width : HOME_CONTENT_WIDTH);
	const center = (line: string): string => centerLine(truncateToWidth(line, contentWidth, "…"), width);
	const block = (line: string): string => line.length === 0 ? "" : placeBlock(truncateToWidth(line, contentWidth, "…"), width, contentWidth);
	const logo = layout === "compact"
		? [center(renderCompactWordmark(theme, animation))]
		: centerBlockLines(renderWordmark(theme, animation, width, layout), width);
	const tagline = config.show_tagline && layout !== "compact" ? [center(color(theme, "dim", "make something different"))] : [];
	const info = layout === "full"
		? renderFullInfo(snapshot, config, contentWidth, theme)
		: renderSummaryInfo(snapshot, config, contentWidth, theme, layout === "compact");
	const tipLine = config.show_tips && layout !== "compact"
		? [center(joinParts([color(theme, "accent", "● Tip"), color(theme, "dim", tip)], "  "))] : [];
	const sections = [logo, tagline, editorLines.map(center), info.map(block), tipLine].filter((section) => section.length > 0);
	return sections.flatMap((section, index) => index === 0 ? section : ["", ...section]);
}

function renderFullInfo(snapshot: TuiSnapshot, config: TuiHomeConfig, width: number, theme: HomeTheme): string[] {
	const project = formatProject(snapshot, theme);
	const context = formatContextPanel(snapshot, theme, true);
	const columnWidth = Math.max(1, Math.floor((width - 6) / 2));
	const lines = context === undefined
		? [color(theme, "dim", "PROJECT"), project]
		: [
			columns(color(theme, "dim", "PROJECT"), color(theme, "dim", "CONTEXT"), columnWidth, 6, width),
			columns(project, context, columnWidth, 6, width),
		];
	lines.push("", color(theme, "dim", "CAPABILITIES"), formatCapabilityCounts(snapshot, theme));
	const summary = config.show_capabilities ? formatCapabilitySummary(summarizeCapabilityGroups(snapshot.tools), width, theme) : undefined;
	if (summary !== undefined) lines.push(summary);
	return lines;
}

function renderSummaryInfo(snapshot: TuiSnapshot, config: TuiHomeConfig, width: number, theme: HomeTheme, compact: boolean): string[] {
	const context = compact ? formatCompactContext(snapshot, theme) : formatContextPanel(snapshot, theme, false);
	const lines = [formatProject(snapshot, theme), joinParts([context, formatCapabilityCounts(snapshot, theme)], color(theme, "dim", " · "))];
	const summary = !compact && config.show_capabilities ? formatCapabilitySummary(summarizeCapabilityGroups(snapshot.tools), width, theme) : undefined;
	if (summary !== undefined) lines.push(summary);
	return lines;
}

function formatContextPanel(snapshot: TuiSnapshot, theme: HomeTheme, showBar: boolean): string | undefined {
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

function formatCompactContext(snapshot: TuiSnapshot, theme: HomeTheme): string | undefined {
	const usage = snapshot.context;
	if (usage === undefined) return undefined;
	if (usage.percent === null) return color(theme, "muted", "ctx ?%");
	const percent = Math.max(0, Math.min(100, usage.percent));
	return contextColor(theme, `ctx ${Math.round(percent)}%`, percent);
}

function formatCapabilityCounts(snapshot: TuiSnapshot, theme: HomeTheme): string {
	const { tools, skills } = snapshot;
	const active = tools.activeNames.length;
	const total = tools.allNames.length;
	const parts = [color(theme, active === total ? "success" : "warning", `${active}/${total} tools`)];
	if (skills !== undefined) {
		parts.push(color(theme, "success", `${skills.totalCount} skills`), color(theme, "text", `${skills.modelInvocableCount} model-invocable`));
	}
	return joinParts(parts, color(theme, "dim", " · "));
}

function columns(left: string, right: string, columnWidth: number, gap: number, width: number): string {
	const fittedLeft = truncateToWidth(left, columnWidth, "…");
	const fittedRight = truncateToWidth(right, columnWidth, "…");
	return truncateToWidth(`${fittedLeft}${" ".repeat(columnWidth - visibleWidth(fittedLeft) + gap)}${fittedRight}`, width, "…");
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

/** Home 优先保留右侧版本，聊天页脚使用另一种宽度分配策略。 */
function alignLine(left: string, right: string, width: number): string {
	if (left.length === 0) return truncateToWidth(right, width, "…");
	const fittedRight = truncateToWidth(right, width, "…");
	const rightWidth = visibleWidth(fittedRight);
	if (rightWidth >= width - 1) return fittedRight;
	const fittedLeft = truncateToWidth(left, Math.max(1, width - rightWidth - 1), "…");
	return `${fittedLeft}${" ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth))}${fittedRight}`;
}

function contextColor(theme: HomeTheme, text: string, percent: number): string {
	return color(theme, percent >= 85 ? "error" : percent >= 60 ? "warning" : "success", text);
}

function color(theme: HomeTheme, name: Parameters<Theme["fg"]>[0], text: string): string {
	return text.length === 0 ? text : theme.fg(name, text);
}
