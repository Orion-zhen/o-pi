import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

import type { WebSearchDetails, WebSearchFailureDetails, WebSearchProgressDetails, WebSearchSuccessDetails } from "./types.js";
import { formatBytes, stripTerminalControls } from "./url-utils.js";

export function renderWebSearchCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, context: { lastComponent?: unknown }): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(formatWebSearchCall(args, theme));
	return text;
}

export function renderWebSearchResult(
	result: { details?: unknown },
	options: { expanded?: boolean; isPartial?: boolean },
	theme: Pick<Theme, "fg" | "bold">,
	context: { lastComponent?: unknown; args?: unknown },
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(formatWebSearchResult(result.details, options, theme, context.args));
	return text;
}

export function formatWebSearchCall(args: unknown, theme: Pick<Theme, "fg" | "bold">): string {
	return [theme.fg("toolTitle", theme.bold("websearch")), theme.fg("accent", `"${queryForCall(args)}"`)].join("  ");
}

export function formatWebSearchResult(
	details: unknown,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: Pick<Theme, "fg" | "bold">,
	args?: unknown,
): string {
	if (options.isPartial || isProgressDetails(details)) return theme.fg("warning", formatProgress(details));
	if (isSuccessDetails(details)) return formatSuccess(details, options.expanded === true, theme);
	if (isFailureDetails(details)) return formatFailure(details, options.expanded === true, theme);
	return formatWebSearchCall(args, theme);
}

export function isWebSearchDetails(value: unknown): value is WebSearchDetails {
	return isSuccessDetails(value) || isFailureDetails(value) || isProgressDetails(value);
}

function formatProgress(details: unknown): string {
	if (!isProgressDetails(details)) return "searching...";
	if (details.phase === "waiting") return details.wait_ms !== undefined ? `waiting ${Math.ceil(details.wait_ms / 1000)}s before searching...` : "waiting before searching...";
	if (details.phase === "downloading") return details.received_bytes !== undefined ? `downloading ${formatBytes(details.received_bytes)}...` : "downloading...";
	if (details.phase === "parsing") return "parsing results...";
	return "searching...";
}

function formatSuccess(details: WebSearchSuccessDetails, expanded: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	const count = details.results.length;
	const countText = count === 0 ? "no results" : `${count} results`;
	const summary = `${formatWebSearchTitle(details.query, theme)}  ${countText} · ${details.duration_ms}ms`;
	if (!expanded) {
		const header = theme.fg(count === 0 ? "warning" : "success", summary);
		const items = details.results.slice(0, 3).map((item) => `  ${item.rank}. ${truncateToWidth(clean(item.title).padEnd(36), 64, "...")}  ${domain(item.url)}`);
		const more = count > 3 ? [`  ... ${count - 3} more`] : [];
		return [header, ...items, ...more].join("\n");
	}

	const rows = details.results.map((item) => {
		const snippet = item.snippet ? `     ${truncateText(clean(item.snippet), 240)}\n` : "";
		return `  ${item.rank}. ${truncateToWidth(clean(item.title), 120, "...")}\n     ${domain(item.url)}\n${snippet}     ${clean(item.url)}`;
	});
	return [
		theme.fg(count === 0 ? "warning" : "success", summary),
		rows.length > 0 ? `\n${rows.join("\n\n")}` : undefined,
		"",
		"  Provider        DuckDuckGo HTML",
		`  Cache           ${details.cached ? "hit" : "miss"}`,
		`  Downloaded      ${formatBytes(details.downloaded_bytes)}`,
		`  Duration        ${details.duration_ms} ms`,
	]
		.filter((item): item is string => item !== undefined)
		.join("\n");
}

function formatFailure(details: WebSearchFailureDetails, expanded: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	const summary = theme.fg("error", `${labelError(details)} · ${clean(details.error.message)}`);
	if (!expanded) return summary;
	return [
		summary,
		`  Error           ${details.error.code}`,
		details.http_status !== undefined ? `  Status          ${details.http_status}` : undefined,
		"  Provider        DuckDuckGo HTML",
		details.duration_ms !== undefined ? `  Duration        ${details.duration_ms} ms` : undefined,
		details.error.code === "PARSE_FAILED" && details.response_preview ? `\n  Response\n${indent(truncateText(clean(details.response_preview), 500))}` : undefined,
	]
		.filter((item): item is string => item !== undefined)
		.join("\n");
}

function formatWebSearchTitle(query: string, theme: Pick<Theme, "fg" | "bold">): string {
	return [theme.fg("toolTitle", theme.bold("websearch")), theme.fg("accent", `"${truncateToWidth(clean(query), 80, "...")}"`)].join("  ");
}

function queryForCall(args: unknown): string {
	if (!isRecord(args) || typeof args["query"] !== "string") return "...";
	return truncateToWidth(clean(args["query"]), 80, "...");
}

function labelError(details: WebSearchFailureDetails): string {
	switch (details.error.code) {
		case "PROVIDER_BLOCKED":
			return "provider blocked";
		case "TIMEOUT":
			return "timeout";
		case "RESPONSE_TOO_LARGE":
			return "too large";
		case "UNSUPPORTED_CONTENT_TYPE":
			return "unsupported";
		default:
			return details.error.code;
	}
}

function domain(value: string): string {
	try {
		return new URL(value).hostname;
	} catch {
		return "";
	}
}

function clean(value: string): string {
	return stripTerminalControls(value)
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function truncateText(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}

function indent(value: string): string {
	return value.split("\n").map((line) => `  ${line}`).join("\n");
}

function isSuccessDetails(value: unknown): value is WebSearchSuccessDetails {
	return isRecord(value) && value["status"] === "success" && Array.isArray(value["results"]) && value["provider"] === "duckduckgo_html";
}

function isFailureDetails(value: unknown): value is WebSearchFailureDetails {
	return isRecord(value) && value["status"] === "failed" && isRecord(value["error"]) && value["provider"] === "duckduckgo_html";
}

function isProgressDetails(value: unknown): value is WebSearchProgressDetails {
	return isRecord(value) && value["status"] === "progress" && typeof value["phase"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
