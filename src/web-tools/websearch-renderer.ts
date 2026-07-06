import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

import { formatToolCard } from "../tui/tool-card.js";
import { formatBytes, formatDuration, joinParts } from "../tui/text.js";
import type { WebSearchDetails, WebSearchFailureDetails, WebSearchProgressDetails, WebSearchProviderAttempt, WebSearchProviderId, WebSearchSuccessDetails } from "./types.js";
import { stripTerminalControls } from "./url-utils.js";

export function renderWebSearchCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, context: { lastComponent?: unknown; isPartial?: boolean }): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(context.isPartial === false ? "" : formatWebSearchCall(args, theme));
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
	const limit = isRecord(args) && typeof args["limit"] === "number" ? `limit ${args["limit"]}` : undefined;
	return formatToolCard({
		tool: "websearch",
		status: "running",
		target: `"${queryForCall(args)}"`,
		summary: joinParts([limit, "providers exa_mcp->duckduckgo_html"]),
	}, theme);
}

export function formatWebSearchResult(
	details: unknown,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: Pick<Theme, "fg" | "bold">,
	args?: unknown,
): string {
	const target = `"${isSuccessDetails(details) ? clean(details.query) : queryForCall(args)}"`;
	if (options.isPartial || isProgressDetails(details)) {
		return formatToolCard({ tool: "websearch", status: "running", target, summary: formatProgress(details) }, theme);
	}
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
	const header = formatToolCard({
		tool: "websearch",
		status: count === 0 ? "warning" : "success",
		target: `"${clean(details.query)}"`,
		summary: joinParts([countText, details.provider, fallbackLabel(details), details.cached ? "cache hit" : "cache miss", formatDuration(details.duration_ms)]),
	}, theme);
	if (!expanded) return header;

	const rows = details.results.map((item) => {
		const snippet = item.snippet ? `     ${truncateText(clean(item.snippet), 240)}\n` : "";
		return `  ${item.rank}. ${truncateToWidth(clean(item.title), 120, "...")}\n     ${domain(item.url)}\n${snippet}     ${clean(item.url)}`;
	});
	return [
		header,
		rows.length > 0 ? `\n${rows.join("\n\n")}` : undefined,
		"",
		`  Provider        ${clean(details.provider)}`,
		`  Cache           ${details.cached ? "hit" : "miss"}`,
		`  Downloaded      ${formatBytes(details.downloaded_bytes)}`,
		`  Duration        ${formatDuration(details.duration_ms)}`,
		formatAttempts(details.attempts),
	]
		.filter((item): item is string => item !== undefined)
		.join("\n");
}

function formatFailure(details: WebSearchFailureDetails, expanded: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	const header = formatToolCard({
		tool: "websearch",
		status: "error",
		target: `"${clean(details.query ?? "query")}"`,
		summary: joinParts([labelError(details), clean(details.error.message)]),
	}, theme);
	if (!expanded) return header;
	return [
		header,
		"",
		`  Error           ${details.error.code}`,
		details.http_status !== undefined ? `  Status          ${details.http_status}` : undefined,
		details.provider !== undefined ? `  Provider        ${clean(details.provider)}` : undefined,
		details.duration_ms !== undefined ? `  Duration        ${formatDuration(details.duration_ms)}` : undefined,
		formatAttempts(details.attempts),
		details.error.code === "PARSE_FAILED" && details.response_preview ? `\n  Response\n${indent(truncateText(clean(details.response_preview), 500))}` : undefined,
	]
		.filter((item): item is string => item !== undefined)
		.join("\n");
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
		case "NO_PROVIDER_AVAILABLE":
			return "all providers unavailable";
		default:
			return details.error.code;
	}
}

function fallbackLabel(details: WebSearchSuccessDetails): string | undefined {
	const failedBeforeSuccess = details.attempts.some((attempt) => attempt.status === "failed");
	return failedBeforeSuccess && details.provider !== "exa_mcp" ? "fallback" : undefined;
}

function formatAttempts(attempts: readonly WebSearchProviderAttempt[] | undefined): string | undefined {
	if (attempts === undefined || attempts.length === 0) return undefined;
	const rows = attempts.map((attempt) => {
		const status = clean(attempt.status).padEnd(8);
		const code = clean(attempt.error?.code ?? "").padEnd(14);
		const duration = attempt.duration_ms !== undefined ? formatDuration(attempt.duration_ms) : attempt.cached ? "cached" : "";
		return `  ${clean(attempt.provider).padEnd(16)}${status}${code}${duration}`;
	});
	return ["", "  Attempts", ...rows].join("\n");
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
	return isRecord(value) && value["status"] === "success" && Array.isArray(value["results"]) && isProvider(value["provider"]);
}

function isFailureDetails(value: unknown): value is WebSearchFailureDetails {
	return isRecord(value) && value["status"] === "failed" && isRecord(value["error"]) && (value["provider"] === undefined || isProvider(value["provider"]));
}

function isProgressDetails(value: unknown): value is WebSearchProgressDetails {
	return isRecord(value) && value["status"] === "progress" && typeof value["phase"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProvider(value: unknown): value is WebSearchProviderId {
	return value === "exa_mcp" || value === "duckduckgo_html";
}
