import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatToolCard } from "../../tui/tool-card.js";
import { joinParts } from "../../tui/text.js";
import { isRepoMapRelatedResults } from "../pi/guards.js";
import type { GrepNearbyResult, GrepParams, GrepRegion, GrepSuccess } from "../types.js";

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
	if (!isGrepSuccess(details)) return "";
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
			details.strategy.join("+"),
			details.truncated ? "truncated" : undefined,
		]),
	}, theme);
	if (!expanded) return header;
	const lines = [header];
	for (const region of details.regions) lines.push(formatRegion(region, theme));
	if (details.nearby !== undefined && details.nearby.length > 0) {
		lines.push(theme.fg("muted", "Nearby (query match not guaranteed):"));
		for (const result of details.nearby) {
			const range = `${result.path}:${result.start_line}${result.end_line === result.start_line ? "" : `-${result.end_line}`}`;
			lines.push(`${theme.fg("accent", range)} ${result.signature ?? result.symbol ?? result.kind} [${result.reason}]`);
		}
	}
	if (details.related !== undefined && details.related.length > 0) {
		lines.push(theme.fg("muted", "Related (repo-map; query match not guaranteed):"));
		for (const result of details.related) {
			const range = result.start_line === undefined
				? result.path
				: `${result.path}:${result.start_line}${result.end_line === undefined || result.end_line === result.start_line ? "" : `-${result.end_line}`}`;
			lines.push(`${theme.fg("accent", range)} ${result.symbol ?? result.signature ?? result.kind} [${result.relations.join(", ")}]`);
		}
	}
	if (details.truncated) lines.push(theme.fg("muted", "truncated"));
	if (details.scope_errors !== undefined && details.scope_errors.length > 0) lines.push(theme.fg("muted", `Scope errors: ${details.scope_errors.map((item) => item.path).join(", ")}.`));
	if (details.skipped_files !== undefined) lines.push(theme.fg("muted", `skipped ${Object.entries(details.skipped_files).map(([key, value]) => `${key}:${value}`).join(" ")}`));
	return lines.join("\n");
}

function formatRegion(region: GrepRegion, theme: Pick<Theme, "fg">): string {
	const symbol = region.symbol ?? region.signature ?? region.kind;
	const range = `${region.path}:${region.start_line}${region.end_line === region.start_line ? "" : `-${region.end_line}`}`;
	return `${theme.fg("accent", range)} ${symbol} [${region.detail}; ${region.reasons.join(", ")}]`;
}

function isGrepSuccess(value: unknown): value is GrepSuccess {
	return isRecord(value)
		&& value["status"] === "success"
		&& typeof value["query"] === "string"
		&& typeof value["path"] === "string"
		&& typeof value["returned_regions"] === "number"
		&& typeof value["returned_files"] === "number"
		&& typeof value["scanned_files"] === "number"
		&& Array.isArray(value["strategy"])
		&& Array.isArray(value["regions"])
		&& (value["nearby"] === undefined || isGrepNearbyResults(value["nearby"]))
		&& (value["related"] === undefined || isRepoMapRelatedResults(value["related"]));
}

function isGrepNearbyResults(value: unknown): value is GrepNearbyResult[] {
	return Array.isArray(value) && value.every((item) =>
		isRecord(item)
		&& typeof item["path"] === "string"
		&& typeof item["start_line"] === "number"
		&& typeof item["end_line"] === "number"
		&& typeof item["kind"] === "string"
		&& (item["reason"] === "symbol similarity" || item["reason"] === "partial terms" || item["reason"] === "path similarity"));
}

function pathArgs(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0);
	return typeof value === "string" && value.length > 0 ? [value] : ["."];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { GrepParams };
