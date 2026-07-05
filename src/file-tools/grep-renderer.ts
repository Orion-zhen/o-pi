import type { Theme } from "@earendil-works/pi-coding-agent";
import type { GrepParams, GrepRegion, GrepSuccess } from "./types.js";

/** 渲染 grep 调用标题；TUI 只显示查询、scope 和 match mode。 */
export function formatGrepCall(args: unknown, theme: Pick<Theme, "fg" | "bold">): string {
	const record = isRecord(args) ? args : {};
	const query = typeof record["query"] === "string" ? record["query"] : "";
	const path = typeof record["path"] === "string" && record["path"].length > 0 ? record["path"] : ".";
	const match = typeof record["match"] === "string" ? record["match"] : "auto";
	const glob = typeof record["glob"] === "string" ? record["glob"] : undefined;
	const suffix = glob === undefined ? "" : ` ${glob}`;
	return `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", JSON.stringify(query))} ${theme.fg("toolOutput", `${path} · ${match}${suffix}`)}`;
}

/** 渲染 grep 结果摘要；TUI 不展示源码正文或内部评分。 */
export function formatGrepResult(details: unknown, expanded: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	if (!isGrepSuccess(details)) return "";
	const header = `${theme.fg("toolTitle", theme.bold("grep"))}  ${JSON.stringify(details.query)}  ${details.returned_regions} regions · ${details.returned_files} files · ${details.strategy.join("+")}`;
	if (!expanded) return header;
	const lines = [header];
	for (const region of details.regions) lines.push(formatRegion(region, theme));
	if (details.truncated) lines.push(theme.fg("muted", "truncated"));
	if (details.skipped_files !== undefined) lines.push(theme.fg("muted", `skipped ${Object.entries(details.skipped_files).map(([key, value]) => `${key}:${value}`).join(" ")}`));
	return lines.join("\n");
}

function formatRegion(region: GrepRegion, theme: Pick<Theme, "fg">): string {
	const symbol = region.symbol ?? region.signature ?? region.kind;
	const range = `${region.path}:${region.start_line}${region.end_line === region.start_line ? "" : `-${region.end_line}`}`;
	return `${theme.fg("accent", range)} ${symbol} [${region.detail}; ${region.reasons.join(", ")}]`;
}

function isGrepSuccess(value: unknown): value is GrepSuccess {
	return isRecord(value) && value["status"] === "success" && Array.isArray(value["regions"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { GrepParams };
