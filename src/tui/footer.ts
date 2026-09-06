import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens, formatWorkspace } from "./format.js";
import { tuiIcon } from "./icons.js";
import { truncateMiddle } from "./text.js";
import type { TuiFooterConfig, TuiSnapshot } from "./types.js";

const NARROW_WIDTH = 80;

/** 字段按固定区域分组，组内保留配置顺序。固定字段只渲染一次。 */
export function formatFooter(snapshot: TuiSnapshot, config: TuiFooterConfig, width: number, theme: Pick<Theme, "fg">): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const segments = safeWidth >= NARROW_WIDTH ? config.segments : config.narrow_segments;
	const separator = theme.fg("dim", " · ");
	const workspace = theme.fg(config.style.workspace_color, truncateMiddle(formatWorkspace(snapshot.cwd), safeWidth > NARROW_WIDTH ? 40 : 22));
	const git = snapshot.git ? theme.fg(config.style.git_color, `${tuiIcon("git")} ${snapshot.git}`) : undefined;
	const context = snapshot.context !== undefined && snapshot.context.percent !== null ? formatContext(snapshot, theme) : undefined;
	const cost = snapshot.costUsd !== undefined || snapshot.usingSubscription
		? theme.fg("dim", `$${(snapshot.costUsd ?? 0).toFixed(3)}${snapshot.usingSubscription ? " (sub)" : ""}`) : undefined;
	const left: string[] = [];
	const right: string[] = [];
	const secondary: Array<"tokens" | "cost"> = [];
	for (const segment of segments) {
		switch (segment) {
			case "cwd": left.push(workspace); break;
			case "git": if (git !== undefined) left.push(git); break;
			case "ctx": if (context !== undefined) right.push(context); break;
			case "tokens": case "cost": secondary.push(segment); break;
		}
	}

	const tools = theme.fg("dim", `tools ${snapshot.tools.activeNames.length}/${snapshot.tools.allNames.length}`);
	const secondaryWidth = Math.max(1, safeWidth - visibleWidth(tools) - 1);
	const costCount = cost === undefined ? 0 : secondary.filter((segment) => segment === "cost").length;
	const tokenBudget = Math.max(1, secondaryWidth - costCount * (visibleWidth(cost ?? "") + visibleWidth(separator)));
	const tokens = secondary.includes("tokens") ? formatTokenStats(snapshot, tokenBudget) : undefined;
	const tokenText = tokens === undefined ? undefined : theme.fg("dim", tokens);
	const usage = secondary.map((segment) => segment === "tokens" ? tokenText : cost).filter((part): part is string => part !== undefined).join(separator);
	return [alignLine(left.join(separator), right.join(separator), safeWidth), alignLine(usage, tools, safeWidth)];
}

/** 空间不足时两侧按原有比例截断，不采用 Home 的右侧优先策略。 */
function alignLine(left: string, right: string, width: number): string {
	if (right.length === 0) return truncateToWidth(left, width, "…");
	if (left.length === 0) return truncateToWidth(right, width, "…");
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + rightWidth + 1 <= width) return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
	const leftBudget = Math.min(leftWidth, Math.max(1, Math.floor((width - 1) * 0.55)));
	const rightBudget = Math.max(1, width - leftBudget - 1);
	const clippedLeft = truncateToWidth(left, leftBudget, "…");
	const clippedRight = truncateToWidth(right, rightBudget, "…");
	const gap = Math.max(1, width - visibleWidth(clippedLeft) - visibleWidth(clippedRight));
	return truncateToWidth(`${clippedLeft}${" ".repeat(gap)}${clippedRight}`, width, "…");
}

/** 同时用于启动横幅，未知用量在横幅中显示 ?。 */
export function formatContext(snapshot: TuiSnapshot, theme: Pick<Theme, "fg">): string | undefined {
	const usage = snapshot.context;
	if (usage === undefined) return undefined;
	const label = theme.fg("dim", "ctx ");
	const window = formatTokens(usage.contextWindow);
	if (usage.percent === null) return `${label}${theme.fg("muted", `?/${window}`)}`;
	return `${label}${applyContextGradient(`${usage.percent.toFixed(1)}%/${window}`, usage.percent)}`;
}

function formatTokenStats(snapshot: TuiSnapshot, width: number): string | undefined {
	const io = [snapshot.inputTokens ? `↑${formatTokens(snapshot.inputTokens)}` : undefined, snapshot.outputTokens ? `↓${formatTokens(snapshot.outputTokens)}` : undefined]
		.filter((part): part is string => part !== undefined).join(" ");
	const cache = formatCacheStats(snapshot, width);
	if (cache === undefined) return io.length > 0 ? io : undefined;
	if (width < 44) return cache;
	return (width < 64 ? [cache, io] : [io, cache]).filter((part) => part.length > 0).join(" ");
}

function formatCacheStats(snapshot: TuiSnapshot, width: number): string | undefined {
	const hasCounts = snapshot.cacheReadTokens !== undefined || snapshot.cacheWriteTokens !== undefined;
	const hasRates = snapshot.latestCacheHitRate !== undefined || snapshot.totalCacheHitRate !== undefined;
	if (!hasCounts && !hasRates) return undefined;
	const counts = hasCounts ? [`R${formatTokens(snapshot.cacheReadTokens ?? 0)}`, `W${formatTokens(snapshot.cacheWriteTokens ?? 0)}`] : [];
	const rates = [
		snapshot.latestCacheHitRate !== undefined ? `hit ${snapshot.latestCacheHitRate.toFixed(1)}%` : undefined,
		snapshot.totalCacheHitRate !== undefined ? `total ${snapshot.totalCacheHitRate.toFixed(1)}%` : undefined,
	].filter((part): part is string => part !== undefined);
	if (width < 44 && rates.length > 0) return `cache ${rates.join(" ")}`;
	if (width < 64 && counts.length > 0) return `cache ${counts.join("/")} ${rates.join(" ")}`.trimEnd();
	return `cache ${[...counts, ...rates].join(" ")}`;
}

function applyContextGradient(text: string, percent: number): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const [red, green, blue] = clamped <= 50
		? interpolateRgb([46, 204, 113], [241, 196, 15], clamped / 50)
		: interpolateRgb([241, 196, 15], [231, 76, 60], (clamped - 50) / 50);
	return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}

function interpolateRgb(from: [number, number, number], to: [number, number, number], ratio: number): [number, number, number] {
	return [
		Math.round(from[0] + (to[0] - from[0]) * ratio),
		Math.round(from[1] + (to[1] - from[1]) * ratio),
		Math.round(from[2] + (to[2] - from[2]) * ratio),
	];
}
