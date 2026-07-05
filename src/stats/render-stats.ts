import path from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { joinParts } from "../tui/text.js";
import type { ContextBreakdownItem, StatsSnapshot } from "./types.js";

const WIDE_WIDTH = 100;
const MEDIUM_WIDTH = 70;

/** 按终端宽度渲染 /stats 只读内容；返回行均不超过 width。 */
export function renderStats(snapshot: StatsSnapshot, width: number): string[] {
	const maxWidth = Math.max(1, width);
	const lines = maxWidth >= WIDE_WIDTH ? renderWide(snapshot, maxWidth) : maxWidth >= MEDIUM_WIDTH ? renderMedium(snapshot, maxWidth) : renderNarrow(snapshot, maxWidth);
	return lines.flatMap((line) => wrapAndFitLine(line, maxWidth));
}

function renderWide(snapshot: StatsSnapshot, width: number): string[] {
	return [
		alignLine("Stats · current session", "q close  ↑↓ scroll", width),
		alignLine(formatWorkspaceStatus(snapshot), formatModelStatus(snapshot), width),
		formatSummaryLine(snapshot),
		"",
		`Context breakdown · current request window · ${snapshot.context.confidence === "exact" ? "exact" : "~estimated"}`,
		renderBreakdownBar(snapshot.context.items, width),
		"",
		columns(["source", "tokens", "share", "note"], [26, 11, 8], "note", width),
		...snapshot.context.items.map((item) => columns([item.label, formatTokens(item.tokens, item.estimated), formatShare(item.share, true), item.note ?? ""], [26, 11, 8], "", width)),
		"",
		"Session usage",
		formatUsage(snapshot),
		"",
		"Cache",
		formatCache(snapshot),
		"",
		"Cost",
		formatCost(snapshot),
		"",
		"Tools",
		formatToolsSummary(snapshot),
		formatToolsByName(snapshot),
	];
}

function renderMedium(snapshot: StatsSnapshot, width: number): string[] {
	return [
		alignLine("Stats · session", "q close  ↑↓ scroll", width),
		alignLine(formatWorkspaceStatus(snapshot), formatModelStatus(snapshot), width),
		formatSummaryLine(snapshot),
		"",
		`Context breakdown · ${snapshot.context.confidence === "exact" ? "exact" : "~estimated"}`,
		renderBreakdownBar(snapshot.context.items, width),
		"",
		columns(["source", "tokens", "%", "note"], [18, 9, 6], "note", width),
		...snapshot.context.items.map((item) => columns([shortLabel(item), formatTokens(item.tokens, item.estimated), formatShare(item.share, false), shortNote(item)], [18, 9, 6], "", width)),
		"",
		"Session usage",
		formatUsage(snapshot),
		"",
		"Cache",
		formatCache(snapshot),
		"",
		"Cost",
		formatCost(snapshot),
		"",
		"Tools",
		formatToolsSummary(snapshot),
		formatToolsByName(snapshot),
	];
}

function renderNarrow(snapshot: StatsSnapshot, width: number): string[] {
	return [
		alignLine("Stats", "q close", width),
		formatWorkspaceStatus(snapshot),
		formatModelStatus(snapshot),
		formatCompactContext(snapshot),
		...snapshot.context.items.map((item) => compactBreakdownLine(item)),
		"",
		"Usage",
		formatUsage(snapshot),
		"",
		"Cache",
		formatCache(snapshot),
		"",
		"Cost",
		formatCost(snapshot),
		"",
		"Tools",
		formatToolsSummary(snapshot),
		formatToolsByName(snapshot),
	];
}

function formatWorkspaceStatus(snapshot: StatsSnapshot): string {
	return joinParts([snapshot.session.cwd ? formatWorkspace(snapshot.session.cwd) : undefined, snapshot.session.git ? `⑂ ${snapshot.session.git}` : undefined, snapshot.session.status]);
}

function formatModelStatus(snapshot: StatsSnapshot): string {
	const model = snapshot.session.modelId === undefined ? undefined : joinParts([snapshot.session.modelProvider, snapshot.session.modelId], "/");
	return joinParts([model, snapshot.session.modelReasoning ? snapshot.session.thinkingLevel : undefined, snapshot.session.usingSubscription ? "subscription" : undefined]);
}

function formatSummaryLine(snapshot: StatsSnapshot): string {
	const context = snapshot.context;
	const tools = snapshot.tools.activeCount !== undefined && snapshot.tools.totalCount !== undefined ? `${snapshot.tools.activeCount}/${snapshot.tools.totalCount} tools` : undefined;
	return joinParts([
		context.totalTokens !== undefined && context.contextWindow !== undefined ? `ctx ${formatTokens(context.totalTokens, context.confidence !== "exact")} / ${formatTokens(context.contextWindow, false)}` : undefined,
		context.percent !== undefined && context.percent !== null ? `${context.percent.toFixed(1)}%` : undefined,
		snapshot.cache.latestHitRate !== undefined ? `cache hit ${snapshot.cache.latestHitRate.toFixed(1)}%` : undefined,
		snapshot.usage.costUsd !== undefined ? `$${snapshot.usage.costUsd.toFixed(3)} est` : undefined,
		tools,
	]);
}

function renderBreakdownBar(items: ContextBreakdownItem[], _width: number): string {
	const parts = items.filter((item) => (item.share ?? 0) >= 0.5).map((item) => `[ ${shortLabel(item)} ${formatShare(item.share, true)} ]`);
	return parts.join(" ");
}

function formatCompactContext(snapshot: StatsSnapshot): string {
	const context = snapshot.context;
	return joinParts([
		context.totalTokens !== undefined && context.contextWindow !== undefined ? `Context · ${formatTokens(context.totalTokens, context.confidence !== "exact")}/${formatTokens(context.contextWindow, false)}` : "Context",
		context.percent !== undefined && context.percent !== null ? `${context.percent.toFixed(1)}%` : undefined,
	]);
}

function compactBreakdownLine(item: ContextBreakdownItem): string {
	return `${padEnd(shortLabel(item), 14)} ${padStart(formatTokens(item.tokens, item.estimated), 8)} ${padStart(formatShare(item.share, true), 6)}`;
}

function formatUsage(snapshot: StatsSnapshot): string {
	const usage = snapshot.usage;
	return joinParts([
		`input ${formatTokens(usage.inputTokens, false)}`,
		`output ${formatTokens(usage.outputTokens, false)}`,
		`cache read ${formatTokens(usage.cacheReadTokens, false)}`,
		`cache write ${formatTokens(usage.cacheWriteTokens, false)}`,
		`observed ${formatTokens(usage.totalObservedTokens, false)}`,
		usage.lastTurnTokens !== undefined ? `last turn ${formatTokens(usage.lastTurnTokens, false)}` : undefined,
		usage.averageTokensPerAssistantTurn !== undefined ? `avg/turn ${formatTokens(usage.averageTokensPerAssistantTurn, false)}` : undefined,
		`turns ${snapshot.session.assistantTurns}`,
	]);
}

function formatCache(snapshot: StatsSnapshot): string {
	const cache = snapshot.cache;
	const value = joinParts([
		cache.latestHitRate !== undefined ? `latest hit ${cache.latestHitRate.toFixed(1)}%` : undefined,
		cache.totalHitRate !== undefined ? `total hit ${cache.totalHitRate.toFixed(1)}%` : undefined,
		cache.readWriteRatio !== undefined ? `read/write ${cache.readWriteRatio.toFixed(1)}x` : undefined,
	]);
	return value || "unknown";
}

function formatCost(snapshot: StatsSnapshot): string {
	return joinParts([
		snapshot.usage.costUsd !== undefined ? `total $${snapshot.usage.costUsd.toFixed(3)} est` : undefined,
		snapshot.usage.lastCostUsd !== undefined ? `last $${snapshot.usage.lastCostUsd.toFixed(3)} est` : undefined,
	]) || "unknown";
}

function formatToolsSummary(snapshot: StatsSnapshot): string {
	return joinParts([
		`${snapshot.tools.calls} calls`,
		snapshot.tools.successes !== undefined ? `${snapshot.tools.successes} ok` : undefined,
		snapshot.tools.failures !== undefined ? `${snapshot.tools.failures} failed` : undefined,
	]);
}

function formatToolsByName(snapshot: StatsSnapshot): string {
	const parts = snapshot.tools.byName.slice(0, 8).map((tool) => `${tool.name} ${tool.calls}${tool.failures !== undefined ? `/${tool.failures} failed` : ""}`);
	return parts.length > 0 ? parts.join(" · ") : "no tool calls";
}

function shortLabel(item: ContextBreakdownItem): string {
	if (item.id === "tool_definitions") return "tools";
	if (item.id === "project_context") return "project";
	if (item.id === "conversation_history") return "history";
	if (item.id === "tool_outputs") return "tool output";
	if (item.id === "current_user") return "current user";
	if (item.id === "unknown_delta") return "delta";
	return item.label.replace(" prompt", "");
}

function shortNote(item: ContextBreakdownItem): string {
	if (item.note === undefined) return "";
	return item.note.replace("messages", "msgs").replace("active tools", "tools").replace("latest user message", "latest input");
}

function columns(values: [string, string, string, string], widths: [number, number, number], fallbackNote: string, _width: number): string {
	const [firstWidth, secondWidth, thirdWidth] = widths;
	const fixed = `${padEnd(values[0], firstWidth)}  ${padStart(values[1], secondWidth)}  ${padStart(values[2], thirdWidth)}  `;
	return `${fixed}${values[3] || fallbackNote}`;
}

function alignLine(left: string, right: string, width: number): string {
	if (right.length === 0) return left;
	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap <= 1) return `${left} ${right}`;
	return `${left}${" ".repeat(gap)}${right}`;
}

function wrapAndFitLine(line: string, width: number): string[] {
	return wrapLine(line, width).map((part) => padEnd(truncateToWidth(part, width, ""), width));
}

function wrapLine(line: string, width: number): string[] {
	if (line.length === 0) return [""];
	const lines: string[] = [];
	let rest = line;
	while (visibleWidth(rest) > width) {
		const split = findWrapSplit(rest, width);
		lines.push(split.head);
		rest = split.tail;
		if (rest.length === 0) break;
	}
	if (rest.length > 0) lines.push(rest);
	return lines.length > 0 ? lines : [""];
}

function findWrapSplit(text: string, width: number): { head: string; tail: string } {
	let usedWidth = 0;
	let headEnd = 0;
	let lastSpaceEnd = -1;
	for (const char of text) {
		const charWidth = visibleWidth(char);
		if (usedWidth + charWidth > width && headEnd > 0) break;
		usedWidth += charWidth;
		headEnd += char.length;
		if (/\s/u.test(char)) lastSpaceEnd = headEnd;
		if (usedWidth >= width) break;
	}
	const splitEnd = lastSpaceEnd > 0 && lastSpaceEnd < text.length ? lastSpaceEnd : Math.max(1, headEnd);
	const head = text.slice(0, splitEnd).trimEnd();
	const tail = text.slice(splitEnd).trimStart();
	return { head: head.length > 0 ? head : text.slice(0, splitEnd), tail };
}

function padEnd(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function padStart(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

function formatWorkspace(cwd: string): string {
	const home = process.env["HOME"] || process.env["USERPROFILE"];
	if (!home) return cwd;
	const resolvedCwd = path.resolve(cwd);
	const resolvedHome = path.resolve(home);
	const relative = path.relative(resolvedHome, resolvedCwd);
	if (relative === "") return "~";
	if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return `~/${relative.split(path.sep).join("/")}`;
	return cwd;
}

function formatTokens(value: number | undefined, estimated: boolean): string {
	if (value === undefined) return "unknown";
	const prefix = estimated ? "~" : "";
	const abs = Math.abs(value);
	if (abs < 1000) return `${prefix}${Math.round(value)}`;
	if (abs < 10_000) return `${prefix}${(value / 1000).toFixed(1)}k`;
	if (abs < 1_000_000) return `${prefix}${Math.round(value / 1000)}k`;
	if (abs < 10_000_000) return `${prefix}${(value / 1_000_000).toFixed(1)}M`;
	return `${prefix}${Math.round(value / 1_000_000)}M`;
}

function formatShare(value: number | undefined, withPercent: boolean): string {
	if (value === undefined) return "unknown";
	return `${value.toFixed(1)}${withPercent ? "%" : ""}`;
}
