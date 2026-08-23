import { VERSION, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatCapabilitySummary, summarizeCapabilityGroups } from "./capabilities.js";
import { formatContext, formatModel, formatWorkspace } from "./footer.js";
import { joinParts } from "./text.js";
import type { TuiFooterSnapshot, TuiHomeConfig } from "./types.js";

const WORDMARK = String.raw`
 ██████╗     ██████╗ 
██╔═══██╗    ██╔══██╗██╗
██║   ██║    ██████╔╝
██║   ██║    ██╔═══╝ ██║
╚██████╔╝    ██║     ██║
 ╚═════╝     ╚═╝     ╚═╝
`.replace(/^\n/, "").trimEnd();
const WORDMARK_LINES = WORDMARK.split("\n");
const FULL_HINTS = "/ commands · /stats · /tools · /agents · ctrl+o details · esc cancel";
const TINY_HINTS = "/ commands · ctrl+o details";
const STATUS_LABEL_WIDTH = 11;
const SIDE_BY_SIDE_MIN_WIDTH = 96;
const TINY_WIDTH = 44;

type ResolvedLayout = "side_by_side" | "stacked" | "tiny";

/** 复用旧版 regular startup banner；缺失数据直接省略，不伪造状态。 */
export function formatStartupBanner(
	snapshot: TuiFooterSnapshot,
	config: Pick<TuiHomeConfig, "show_hints" | "show_capabilities">,
	width: number,
	theme: Pick<Theme, "fg">,
): string[] {
	const safeWidth = Math.max(1, width);
	const layout = resolveLayout(safeWidth);
	const lines = layout === "tiny"
		? renderTiny(snapshot, config, safeWidth, theme)
		: layout === "side_by_side"
			? renderSideBySide(snapshot, config, safeWidth, theme)
			: renderStacked(snapshot, config, safeWidth, theme);
	return ["", ...lines.map((line) => truncateToWidth(line, safeWidth, "…"))];
}

export function createStartupBannerComponent(
	config: Pick<TuiHomeConfig, "show_hints" | "show_capabilities">,
	getSnapshot: () => TuiFooterSnapshot,
): (tui: TUI, theme: Theme) => Component {
	return (_tui, theme) => ({
		render(width: number): string[] {
			return formatStartupBanner(getSnapshot(), config, width, theme);
		},
		invalidate(): void {},
	});
}

function resolveLayout(width: number): ResolvedLayout {
	if (width < TINY_WIDTH) return "tiny";
	return width >= SIDE_BY_SIDE_MIN_WIDTH ? "side_by_side" : "stacked";
}

function renderSideBySide(
	snapshot: TuiFooterSnapshot,
	config: Pick<TuiHomeConfig, "show_hints" | "show_capabilities">,
	width: number,
	theme: Pick<Theme, "fg">,
): string[] {
	const logo = coloredWordmark(theme);
	const logoWidth = Math.max(...logo.map(visibleWidth));
	const gap = 7;
	const rightWidth = Math.max(1, width - logoWidth - gap);
	const rows = statusRows(snapshot, config, rightWidth, theme);
	const count = Math.max(logo.length, rows.length);
	const lines: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const left = logo[index] ?? "";
		const paddedLeft = padRight(left, logoWidth);
		const right = rows[index] ?? "";
		lines.push(truncateToWidth(`${paddedLeft}${" ".repeat(gap)}${right}`, width, "…"));
	}
	if (config.show_hints) lines.push("", color(theme, "dim", FULL_HINTS));
	return lines;
}

function renderStacked(
	snapshot: TuiFooterSnapshot,
	config: Pick<TuiHomeConfig, "show_hints" | "show_capabilities">,
	width: number,
	theme: Pick<Theme, "fg">,
): string[] {
	const lines = [...coloredWordmark(theme), "", ...statusRows(snapshot, config, width, theme)];
	if (config.show_hints) lines.push(row("keys", color(theme, "dim", FULL_HINTS), width, theme));
	return lines;
}

function renderTiny(
	snapshot: TuiFooterSnapshot,
	config: Pick<TuiHomeConfig, "show_hints" | "show_capabilities">,
	width: number,
	theme: Pick<Theme, "fg">,
): string[] {
	const workspace = formatWorkspaceWithGit(snapshot, theme);
	const title = color(theme, "accent", "O Pi");
	const lines = [joinParts([title, workspace], color(theme, "dim", " · "))];
	const tools = formatTinyTools(snapshot, config, width, theme);
	if (tools !== undefined) lines.push(tools);
	if (config.show_hints) lines.push(color(theme, "dim", TINY_HINTS));
	return lines;
}

function statusRows(
	snapshot: TuiFooterSnapshot,
	config: Pick<TuiHomeConfig, "show_capabilities">,
	width: number,
	theme: Pick<Theme, "fg">,
): string[] {
	const workspace = formatWorkspaceWithGit(snapshot, theme);
	const model = formatModel(snapshot);
	const contextStatus = formatContextStatus(snapshot, theme);
	const tools = formatTools(snapshot, config, width, theme);
	const skills = formatSkills(snapshot, theme);
	return [
		row("pi", `v${VERSION}`, width, theme),
		workspace ? row("workspace", workspace, width, theme) : undefined,
		model ? row("model", color(theme, "text", model), width, theme) : undefined,
		contextStatus ? row("context", contextStatus, width, theme) : undefined,
		tools ? row("tools", tools, width, theme) : undefined,
		skills ? row("skills", skills, width, theme) : undefined,
	].filter((line): line is string => line !== undefined);
}

function row(label: string, value: string, width: number, theme: Pick<Theme, "fg">): string {
	const labelText = color(theme, "dim", label.padEnd(STATUS_LABEL_WIDTH, " "));
	const valueWidth = Math.max(1, width - visibleWidth(labelText));
	return truncateToWidth(`${labelText}${truncateToWidth(value, valueWidth, "…")}`, width, "…");
}

function formatWorkspaceWithGit(snapshot: TuiFooterSnapshot, theme: Pick<Theme, "fg">): string | undefined {
	if (!snapshot.cwd) return undefined;
	const workspace = color(theme, "accent", formatWorkspace(snapshot.cwd));
	if (!snapshot.git) return workspace;
	return joinParts([workspace, color(theme, "success", snapshot.git)], color(theme, "dim", " · "));
}

function formatContextStatus(snapshot: TuiFooterSnapshot, theme: Pick<Theme, "fg">): string | undefined {
	const context = snapshot.context === undefined ? undefined : formatContext(snapshot, theme);
	if (context === undefined) return undefined;
	const status = snapshot.status === undefined
		? undefined
		: color(theme, snapshot.status === "ready" ? "success" : "warning", snapshot.status);
	return joinParts([context, status], color(theme, "dim", " · ")) || undefined;
}

function formatTools(
	snapshot: TuiFooterSnapshot,
	config: Pick<TuiHomeConfig, "show_capabilities">,
	width: number,
	theme: Pick<Theme, "fg">,
): string | undefined {
	const tools = snapshot.tools;
	if (tools === undefined) return undefined;
	const activeCount = tools.activeNames.length;
	const totalCount = tools.totalCount;
	const count = color(theme, activeCount === totalCount ? "success" : "warning", `${activeCount}/${totalCount}`);
	if (!config.show_capabilities) return count;
	const usedWidth = visibleWidth(count) + visibleWidth(" · ");
	const summary = formatCapabilitySummary(
		summarizeCapabilityGroups(tools),
		Math.max(1, width - STATUS_LABEL_WIDTH - usedWidth),
		theme,
	);
	return joinParts([count, summary], color(theme, "dim", " · "));
}

function formatSkills(snapshot: TuiFooterSnapshot, theme: Pick<Theme, "fg">): string | undefined {
	const skills = snapshot.skills;
	if (skills === undefined) return undefined;
	return joinParts(
		[color(theme, "success", `${skills.totalCount}`), `model:${skills.modelInvocableCount}`],
		color(theme, "dim", " · "),
	);
}

function formatTinyTools(
	snapshot: TuiFooterSnapshot,
	config: Pick<TuiHomeConfig, "show_capabilities">,
	width: number,
	theme: Pick<Theme, "fg">,
): string | undefined {
	const tools = snapshot.tools;
	if (tools === undefined) return undefined;
	const activeCount = tools.activeNames.length;
	const totalCount = tools.totalCount;
	const count = color(theme, activeCount === totalCount ? "success" : "warning", `${activeCount}/${totalCount} tools`);
	if (!config.show_capabilities) {
		return truncateToWidth(joinParts([count, formatTinySkills(snapshot)], color(theme, "dim", " · ")), width, "…");
	}
	const usedWidth = visibleWidth(count) + visibleWidth(" · ");
	const summary = formatCapabilitySummary(summarizeCapabilityGroups(tools), Math.max(1, width - usedWidth), theme);
	return truncateToWidth(
		joinParts([count, formatTinySkills(snapshot), summary], color(theme, "dim", " · ")),
		width,
		"…",
	);
}

function formatTinySkills(snapshot: TuiFooterSnapshot): string | undefined {
	const skills = snapshot.skills;
	if (skills === undefined) return undefined;
	return `skills:${skills.totalCount} model:${skills.modelInvocableCount}`;
}

function coloredWordmark(theme: Pick<Theme, "fg">): string[] {
	return WORDMARK_LINES.map((line) => color(theme, "accent", line));
}

function padRight(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function color(theme: Pick<Theme, "fg">, colorName: Parameters<Theme["fg"]>[0], text: string): string {
	return theme.fg(colorName, text);
}
