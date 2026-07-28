import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatToolCard } from "../../tui/tool-card.js";
import { joinParts } from "../../tui/text.js";
import { isGrepSuccessDetails } from "../pi/guards.js";
import type { GrepParams, GrepRegion, TruncationReason } from "./types.js";

const LIMIT_LABELS: Record<TruncationReason, string> = {
	traversal_limit: "depth",
	text_byte_limit: "bytes",
	semantic_candidate_limit: "sem",
	result_limit: "result",
	token_budget: "token",
};

/** 渲染 grep 调用标题；TUI 只显示查询、scope 和 match mode。 */
export function formatGrepCall(args: unknown, theme: Pick<Theme, "fg" | "bold">): string {
	const record = isRecord(args) ? args : {};
	const query = typeof record["query"] === "string" ? record["query"] : "";
	const paths = pathArgs(record["path"]);
	const match = typeof record["match"] === "string" ? record["match"] : "auto";
	const glob = typeof record["glob"] === "string" ? record["glob"] : undefined;
	return formatToolCard(
		{ tool: "grep", status: "running", target: `${JSON.stringify(query)} in ${paths.join(", ")}`, summary: joinParts([match, glob]) },
		theme,
	);
}

/** 渲染 grep 结果摘要；TUI 不展示源码正文或内部评分。 */
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
			details.nearby === undefined ? undefined : `${details.nearby.length} nearby`,
			details.related === undefined ? undefined : `${details.related.length} related`,
			`${details.stats.searched_files}/${details.stats.traversed_entries} searched/traversed`,
			details.truncated_by.length > 0 ? `limit:${formatLimitReasons(details.truncated_by)}` : undefined,
			details.scope_errors === undefined || details.scope_errors.length === 0 ? undefined : `${details.scope_errors.length} scope ${details.scope_errors.length === 1 ? "error" : "errors"}`,
		]),
	}, theme);
	if (!expanded) return header;
	const lines = [header];
	for (const region of details.regions) lines.push(formatRegion(region, theme));
	if (details.nearby !== undefined && details.nearby.length > 0) {
		lines.push(theme.fg("muted", "Nearby (query match not guaranteed):"));
		for (const result of details.nearby) {
			const range = `${result.path}:${result.start_line}${result.end_line === result.start_line ? "" : `-${result.end_line}`}`;
			lines.push(`${theme.fg("accent", range)} ${result.symbol ?? result.kind} [${result.reason}]`);
		}
	}
	if (details.related !== undefined && details.related.length > 0) {
		lines.push(theme.fg("muted", "Related (query match not guaranteed):"));
		for (const result of details.related) {
			const range = result.start_line === undefined
				? result.path
				: `${result.path}:${result.start_line}${result.end_line === undefined || result.end_line === result.start_line ? "" : `-${result.end_line}`}`;
			lines.push(`${theme.fg("accent", range)} ${result.symbol ?? result.kind} [${result.relations.join(", ")}]`);
		}
	}
	if (details.truncated_by.length > 0) lines.push(theme.fg("muted", `limit: ${formatLimitReasons(details.truncated_by, ", ")}`));
	if (details.scope_errors !== undefined && details.scope_errors.length > 0) lines.push(theme.fg("muted", `Scope errors: ${details.scope_errors.map((item) => `${item.path}:${item.error.code}`).join(", ")}.`));
	if (details.stats.skipped_files !== undefined) lines.push(theme.fg("muted", `skipped ${Object.entries(details.stats.skipped_files).map(([key, value]) => `${key}:${value}`).join(" ")}`));
	return lines.join("\n");
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
