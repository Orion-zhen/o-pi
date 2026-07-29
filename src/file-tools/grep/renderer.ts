import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatToolCard } from "../../tui/tool-card.js";
import { joinParts } from "../../tui/text.js";
import { isGrepSuccessDetails } from "../pi/guards.js";
import type { GrepParams, GrepRegion, TruncationReason } from "./types.js";

const LIMIT_LABELS: Record<TruncationReason, string> = {
	traversal_limit: "depth",
	result_limit: "result",
};

/** 渲染 grep 调用标题；TUI 只显示查询、scope 和 glob。 */
export function formatGrepCall(args: unknown, theme: Pick<Theme, "fg" | "bold">): string {
	const record = isRecord(args) ? args : {};
	const query = typeof record["query"] === "string" ? record["query"] : "";
	const paths = pathArgs(record["path"]);
	const glob = typeof record["glob"] === "string" ? record["glob"] : undefined;
	return formatToolCard(
		{ tool: "grep", status: "running", target: `${JSON.stringify(query)} in ${paths.join(", ")}`, summary: joinParts([glob]) },
		theme,
	);
}

/** 渲染 grep 结果；展开态压缩展示 text 匹配行，不展开代码区域正文或内部评分。 */
export function formatGrepResult(details: unknown, expanded: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	if (!isGrepSuccessDetails(details)) return "";
	const scope = (details.paths ?? [details.path]).join(", ");
	const header = formatToolCard({
		tool: "grep",
		status: "success",
		target: `${JSON.stringify(details.query)} in ${scope}`,
		summary: joinParts([
			`${details.returned_regions} regions`,
			`${details.returned_files} files`,
			`${details.stats.searched_files}/${details.stats.traversed_entries} searched/traversed`,
			details.query_mode === "literal_fallback" ? "literal fallback" : undefined,
			details.truncated_by.length > 0 ? `limit:${formatLimitReasons(details.truncated_by)}` : undefined,
			details.scope_errors === undefined || details.scope_errors.length === 0 ? undefined : `${details.scope_errors.length} scope ${details.scope_errors.length === 1 ? "error" : "errors"}`,
		]),
	}, theme);
	if (!expanded) return header;
	const lines = [header];
	if (details.query_mode === "literal_fallback") lines.push(theme.fg("warning", "invalid regex; exact literal fallback used"));
	appendRegions(lines, details.regions, theme);
	if (details.truncated_by.length > 0) lines.push(theme.fg("muted", `limit: ${formatLimitReasons(details.truncated_by, ", ")}`));
	if (details.scope_errors !== undefined && details.scope_errors.length > 0) lines.push(theme.fg("muted", `Scope errors: ${details.scope_errors.map((item) => `${item.path}:${item.error.code}`).join(", ")}.`));
	if (details.stats.skipped_files !== undefined) lines.push(theme.fg("muted", `skipped ${Object.entries(details.stats.skipped_files).map(([key, value]) => `${key}:${value}`).join(" ")}`));
	return lines.join("\n");
}

function appendRegions(output: string[], regions: readonly GrepRegion[], theme: Pick<Theme, "fg">): void {
	let index = 0;
	while (index < regions.length) {
		const region = regions[index];
		if (region === undefined) break;
		if (region.kind !== "text") {
			output.push(formatRegion(region, theme));
			index += 1;
			continue;
		}
		const grouped = [region];
		let nextIndex = index + 1;
		while (nextIndex < regions.length) {
			const next = regions[nextIndex];
			if (next === undefined || !sameTextDisplayGroup(region, next)) break;
			grouped.push(next);
			nextIndex += 1;
		}
		output.push(grouped.length === 1 ? formatTextRegion(region, theme) : formatTextRegionGroup(region, grouped, theme));
		index = nextIndex;
	}
}

function sameTextDisplayGroup(left: GrepRegion, right: GrepRegion): boolean {
	return right.kind === "text"
		&& left.path === right.path
		&& left.query_match === right.query_match
		&& left.matched_by.join("\0") === right.matched_by.join("\0");
}

function formatTextRegionGroup(
	first: GrepRegion,
	regions: readonly GrepRegion[],
	theme: Pick<Theme, "fg">,
): string {
	const evidence = first.query_match === "semantic" ? " [evidence=lexical]" : "";
	const lines = [theme.fg("accent", `${first.path}${evidence}:`)];
	for (const region of regions) {
		const display = region.display_lines?.[0];
		lines.push(display === undefined
			? `  ${region.start_line}:`
			: `  ${display.line}: ${display.text}`);
	}
	return lines.join("\n");
}

function formatTextRegion(region: GrepRegion, theme: Pick<Theme, "fg">): string {
	const display = region.display_lines?.[0];
	if (display === undefined) return theme.fg("accent", `${region.path}:${region.start_line}:`);
	const range = theme.fg("accent", `${region.path}:${display.line}`);
	return display.type === "match"
		? `${range}: ${display.text}`
		: `${range} [evidence=lexical]: ${display.text}`;
}

function formatLimitReasons(reasons: readonly TruncationReason[], separator = ","): string {
	return reasons.map((reason) => LIMIT_LABELS[reason]).join(separator);
}

function formatRegion(region: GrepRegion, theme: Pick<Theme, "fg">): string {
	const range = `${region.path}:${region.start_line}${region.end_line === region.start_line ? "" : `-${region.end_line}`}`;
	const metadata = [
		`kind=${region.kind}`,
		...(region.symbol === undefined ? [] : [`symbol=${region.symbol}`]),
		...(region.roles === undefined || region.roles.length === 0 ? [] : [`roles=${region.roles.map(kebabCase).join(",")}`]),
		...(region.matched_by.length === 0 ? [] : [`matched-by=${region.matched_by.join(",")}`]),
		...(region.match_lines === undefined ? [] : [`matches=${region.match_lines.length}`]),
	];
	return `${theme.fg("accent", range)} [${metadata.join("; ")}]`;
}

function kebabCase(value: string): string {
	return value.replaceAll("_", "-").replace(/\s+/gu, "-").toLocaleLowerCase();
}

function pathArgs(value: unknown): string[] {
	if (Array.isArray(value)) {
		const paths = value.filter((item): item is string => typeof item === "string" && item.length > 0);
		return paths.length > 0 ? paths : ["."];
	}
	return typeof value === "string" && value.length > 0 ? [value] : ["."];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { GrepParams };
