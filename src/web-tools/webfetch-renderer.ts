import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { formatToolCard } from "../tui/tool-card.js";
import { formatBytes, formatChars, formatDuration, joinParts } from "../tui/text.js";
import type { WebFetchDetails, WebFetchFailureDetails, WebFetchProgressDetails, WebFetchSuccessDetails } from "./types.js";
import { compactUrl, shortUrlForCall, truncateMiddle } from "./url-utils.js";

interface WebFetchRenderState {
	callComponent?: Text;
}

interface WebFetchCallContext {
	lastComponent?: unknown;
	state: WebFetchRenderState;
}

interface WebFetchResultContext extends WebFetchCallContext {
	args?: unknown;
}

export function renderWebFetchCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, context: WebFetchCallContext): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	context.state.callComponent = text;
	text.setText(formatWebFetchCall(args, theme));
	return text;
}

export function renderWebFetchResult(
	result: { details?: unknown },
	options: { expanded?: boolean; isPartial?: boolean },
	theme: Pick<Theme, "fg" | "bold">,
	context: WebFetchResultContext,
): Text {
	context.state.callComponent?.setText("");
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(formatWebFetchResult(result.details, options, theme, context.args));
	return text;
}

export function formatWebFetchCall(args: unknown, theme: Pick<Theme, "fg" | "bold">): string {
	return formatToolCard({ tool: "webfetch", status: "running", target: shortUrlForCall(args), summary: invocationSummary(args) }, theme);
}

function invocationSummary(args: unknown): string {
	const mode = isRecord(args) && args["mode"] === "source" ? "source" : "readable";
	const offset = isRecord(args) && typeof args["offset"] === "number" ? args["offset"] : undefined;
	const limit = isRecord(args) && typeof args["limit"] === "number" ? args["limit"] : undefined;
	const range = offset !== undefined && offset > 0
		? limit !== undefined ? `offset ${offset}-${offset + limit}` : `offset ${offset}+`
		: "offset 0";
	return joinParts([mode, range]);
}

export function formatWebFetchResult(
	details: unknown,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: Pick<Theme, "fg" | "bold">,
	_args?: unknown,
): string {
	const target = isRecord(_args) ? shortUrlForCall(_args) : targetFromDetails(details);
	if (options.isPartial || isProgressDetails(details)) {
		return formatToolCard({ tool: "webfetch", status: "running", target, summary: joinParts([invocationSummary(_args), formatProgress(details)]) }, theme);
	}
	if (isSuccessDetails(details)) return formatSuccess(details, options.expanded === true, theme);
	if (isFailureDetails(details)) return formatFailure(details, options.expanded === true, theme);
	return formatToolCard({ tool: "webfetch", status: "neutral", target, summary: "waiting" }, theme);
}

export function isWebFetchDetails(value: unknown): value is WebFetchDetails {
	return isSuccessDetails(value) || isFailureDetails(value) || isProgressDetails(value);
}

function formatProgress(details: unknown): string {
	if (!isProgressDetails(details)) return "requesting...";
	if (details.phase === "redirecting") return "redirecting...";
	if (details.phase === "converting") return "converting HTML -> Markdown...";
	if (details.phase === "downloading") {
		return details.received_bytes !== undefined ? `downloading ${formatBytes(details.received_bytes)}...` : "downloading...";
	}
	return "requesting...";
}

function formatSuccess(details: WebFetchSuccessDetails, expanded: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	const format = labelFormat(details.format);
	const range = details.range.next_offset !== undefined
		? `${formatChars(details.range.start)}-${formatChars(details.range.end)} of ${formatChars(details.range.total)}`
		: formatChars(details.total_chars);
	const header = formatToolCard({
		tool: "webfetch",
		status: "success",
		target: compactUrl(details.final_url),
		summary: joinParts([
			`${details.http_status}`,
			format.toLowerCase(),
			details.page_kind,
			details.text_source,
			range,
			details.range.next_offset !== undefined ? "more" : undefined,
			details.completeness === "partial" ? "partial" : undefined,
			details.completeness === "partial" ? primaryOmission(details) : undefined,
			details.media.returned > 0 ? `${details.media.returned} image` : undefined,
			formatDuration(details.duration_ms),
		]),
	}, theme);
	if (!expanded) return header;
	const detailSummaryParts = [
		details.title ? `"${truncateMiddle(details.title, 48)}"` : undefined,
		`${details.http_status}`,
		format,
		details.page_kind,
		details.text_source,
		range,
		details.authenticated ? "auth" : undefined,
		details.range.next_offset !== undefined ? "more" : undefined,
		details.completeness === "partial" ? "partial" : undefined,
		details.media.returned > 0 ? `${details.media.returned} image` : undefined,
		details.snapshot === "hit" ? "snapshot" : undefined,
		formatDuration(details.duration_ms),
	].filter((item): item is string => item !== undefined);
	const summary = theme.fg("success", detailSummaryParts.join(" · "));
	return [
		header,
		"",
		summary,
		`  Status          ${details.http_status}`,
		`  Final URL       ${details.final_url}`,
		`  Content         ${details.content_type ?? "unknown"} -> ${details.format}`,
		details.charset ? `  Encoding        ${details.charset}` : undefined,
		`  Downloaded      ${formatBytes(details.downloaded_bytes)}`,
		`  Returned        chars ${details.range.start}-${details.range.end} of ${details.range.total}`,
		`  Page            ${details.page_kind}`,
		`  Text source     ${details.text_source}`,
		`  Completeness    ${details.completeness}`,
		details.deferred_fragments.discovered > 0
			? `  Deferred       ${details.deferred_fragments.resolved}/${details.deferred_fragments.discovered} resolved`
			: undefined,
		details.media.discovered > 0 ? `  Media          ${details.media.returned}/${details.media.discovered} returned` : undefined,
		details.omissions.length > 0 ? `  Omitted         ${details.omissions.map((item) => `${item.kind}:${item.reason}`).join(", ")}` : undefined,
		details.authenticated ? "  Authentication  cookie" : undefined,
		`  Snapshot        ${details.snapshot}`,
		details.redirect_count > 0 ? `  Redirects       ${details.redirect_count}` : undefined,
		`  Duration        ${details.duration_ms} ms`,
		details.preview ? `\n  Preview\n${indent(details.preview)}` : undefined,
	]
		.filter((item): item is string => item !== undefined)
		.join("\n");
}

function primaryOmission(details: WebFetchSuccessDetails): string | undefined {
	const omission = details.omissions[0];
	return omission === undefined ? undefined : `${omission.kind}:${omission.reason}`;
}

function formatFailure(details: WebFetchFailureDetails, expanded: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	const status = details.http_status !== undefined ? `${details.http_status} ` : "";
	const header = formatToolCard({
		tool: "webfetch",
		status: "error",
		target: compactUrl(details.final_url ?? details.requested_url ?? "url"),
		summary: joinParts([status.trim(), labelError(details), details.error.message]),
	}, theme);
	if (!expanded) return header;
	return [
		header,
		"",
		`  Error           ${details.error.code}`,
		details.http_status !== undefined ? `  Status          ${details.http_status}` : undefined,
		details.final_url ? `  Final URL       ${details.final_url}` : undefined,
		details.authenticated ? "  Authentication  cookie" : undefined,
		details.redirect_count !== undefined && details.redirect_count > 0 ? `  Redirects       ${details.redirect_count}` : undefined,
		details.duration_ms !== undefined ? `  Duration        ${details.duration_ms} ms` : undefined,
		details.response_preview ? `\n  Response\n${indent(details.response_preview)}` : undefined,
	]
		.filter((item): item is string => item !== undefined)
		.join("\n");
}

function targetFromDetails(details: unknown): string {
	if (isSuccessDetails(details)) return compactUrl(details.final_url);
	if (isFailureDetails(details)) return compactUrl(details.final_url ?? details.requested_url ?? "url");
	return "url";
}

function labelFormat(format: string): string {
	if (format === "markdown") return "Markdown";
	if (format === "json") return "JSON";
	if (format === "xml") return "XML";
	if (format === "image") return "Image";
	if (format === "source") return "Source";
	return "Text";
}

function labelError(details: WebFetchFailureDetails): string {
	switch (details.error.code) {
		case "BLOCKED_ADDRESS":
			return "blocked";
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

function indent(value: string): string {
	return value.split("\n").slice(0, 12).map((line) => `  ${line}`).join("\n");
}

function isSuccessDetails(value: unknown): value is WebFetchSuccessDetails {
	return isRecord(value)
		&& value["status"] === "success"
		&& value["scope"] === "static_response"
		&& isPageKind(value["page_kind"])
		&& isTextSource(value["text_source"])
		&& (value["completeness"] === "complete" || value["completeness"] === "partial")
		&& Array.isArray(value["omissions"])
		&& typeof value["http_status"] === "number"
		&& isRecord(value["range"])
		&& isRecord(value["deferred_fragments"])
		&& isRecord(value["media"]);
}

function isPageKind(value: unknown): boolean {
	return value === "article" || value === "image" || value === "video" || value === "audio" || value === "generic";
}

function isTextSource(value: unknown): boolean {
	return value === "readability" || value === "semantic" || value === "heading" || value === "body" || value === "metadata";
}

function isFailureDetails(value: unknown): value is WebFetchFailureDetails {
	return isRecord(value) && value["status"] === "failed" && isRecord(value["error"]) && typeof value["error"]["code"] === "string";
}

function isProgressDetails(value: unknown): value is WebFetchProgressDetails {
	return isRecord(value) && value["status"] === "progress" && typeof value["phase"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
