import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatToolCard } from "../../../tui/tool-card.js";
import { compactWhitespace, formatBytes, formatChars, joinParts, truncateEnd } from "../../../tui/text.js";
import type { ReadImageSuccess, ReadPdfSuccess, ReadSuccess } from "../../read/types.js";
import { isReadFileSuccess, isReadImageSuccess, isReadPdfSuccess, isReadSuccess } from "../../read/guards.js";
import { isPlainRecord } from "../../pi/guards.js";
import type { PartialTextRenderContext, TextRenderContext, ToolReadResult } from "./contracts.js";
import { displayToolPath, fallbackTextResult, formatFailureCard, stringArg, textComponent } from "./shared.js";

export function renderReadCall(
	args: unknown,
	theme: Pick<Theme, "fg" | "bold">,
	context: PartialTextRenderContext,
): Text {
	const text = textComponent(context.lastComponent);
	text.setText(context.isPartial === false ? "" : formatReadCall(args, theme, context.cwd));
	return text;
}

export function renderReadResult(
	result: ToolReadResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Pick<Theme, "fg" | "bold">,
	context: TextRenderContext,
): Text {
	const text = textComponent(context.lastComponent);
	text.setText(formatReadResult(result, options.expanded, options.isPartial, theme, context.args, context.cwd));
	return text;
}

function formatReadCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	const rawPath = stringArg(record["path"]);
	const lines = stringArg(record["lines"]);
	const pages = stringArg(record["pages"]);
	const range = joinParts([
		lines === null ? undefined : `lines ${lines}`,
		pages === null ? undefined : `pages ${pages}`,
	]) || "file";
	return formatToolCard({ tool: "read", status: "running", target: displayToolPath(rawPath, cwd), summary: range }, theme);
}

function formatReadResult(
	result: ToolReadResult,
	expanded: boolean,
	isPartial: boolean,
	theme: Pick<Theme, "fg" | "bold">,
	args: unknown,
	cwd: string,
): string {
	const target = isReadFileSuccess(result.details) ? result.details.path : readTarget(args, cwd);
	if (isPartial) return formatToolCard({ tool: "read", status: "running", target, summary: "reading file" }, theme);
	const failure = formatFailureCard("read", target, result.details, args, expanded, theme);
	if (failure !== undefined) return failure;
	if (isReadImageSuccess(result.details)) return formatReadImageResult(result.details, expanded, theme);
	if (isReadPdfSuccess(result.details)) return formatReadPdfResult(result.details, expanded, theme);
	if (!isReadSuccess(result.details)) return fallbackTextResult(result, expanded, theme, 10);
	return formatReadTextResult(result.details, expanded, theme);
}

function formatReadImageResult(
	details: ReadImageSuccess,
	expanded: boolean,
	theme: Pick<Theme, "fg" | "bold">,
): string {
	const header = formatToolCard({
		tool: "read",
		status: "success",
		target: details.path,
		summary: joinParts(["image", details.image.mime_type, formatBytes(details.size_bytes), "attached"]),
	}, theme);
	if (!expanded) return header;
	return `${header}\n\n${theme.fg("toolOutput", details.content)}`;
}

function formatReadPdfResult(
	details: ReadPdfSuccess,
	expanded: boolean,
	theme: Pick<Theme, "fg" | "bold">,
): string {
	const header = formatToolCard({
		tool: "read",
		status: "success",
		target: details.path,
		summary: joinParts([
			`pages ${details.start_page}-${details.end_page}/${details.total_pages}`,
			`${details.pages.length} attached`,
			formatBytes(details.size_bytes),
			details.truncated ? "more" : undefined,
		]),
	}, theme);
	if (!expanded) return header;
	const pages = details.pages.flatMap((page) => {
		const label = page.label === undefined || page.label === String(page.number)
			? undefined
			: `label ${truncateEnd(compactWhitespace(page.label), 80)}`;
		const summary = joinParts([
			`page ${page.number}`,
			label,
			page.image.mime_type,
			`${page.width_points}x${page.height_points} pt`,
			page.rotation === 0 ? undefined : `rotation ${page.rotation}`,
		]);
		return [
			theme.fg("toolOutput", summary),
			...(page.hints ?? []).map((hint) => theme.fg("toolOutput", `  ${truncateEnd(compactWhitespace(hint), 160)}`)),
		];
	});
	return `${header}\n\n${pages.join("\n")}`;
}

function formatReadTextResult(details: ReadSuccess, expanded: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	const header = formatToolCard({
		tool: "read",
		status: "success",
		target: details.path,
		summary: joinParts([
			`lines ${details.start_line}-${details.end_line}/${details.total_lines}`,
			formatChars(details.content.length),
			details.truncated || details.continuation !== undefined ? "more" : undefined,
		]),
	}, theme);
	if (!expanded) return header;
	return `${header}\n\n${theme.fg("toolOutput", details.content)}`;
}

function readTarget(args: unknown, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	return displayToolPath(stringArg(record["path"]), cwd);
}
