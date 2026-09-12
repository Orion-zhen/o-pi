import type { FailedResult, FileToolError } from "../shared/result.js";
import { isPlainRecord } from "./guards.js";

/** File-tool failure body; complete structured details stay outside model text. */
export function formatErrorModelResult(result: FailedResult): string {
	const errors = [result.error, ...(result.error.errors ?? [])];
	const body = errors.map(formatErrorBody).join("\n");
	const next = [...new Set(errors.flatMap((error) => error.next === undefined ? [] : [error.next]))]
		.map((hint) => `\nnext: ${escapeXmlText(hint)}`).join("");
	return `<error>\n${body}${next}\n</error>`;
}

function formatErrorBody(error: FileToolError): string {
	const hints = error.code === "OLD_TEXT_NOT_UNIQUE"
		? formatEditMatchHints(error.details)
		: error.code === "OLD_TEXT_NOT_FOUND"
			? formatEditNotFoundHints(error.details)
			: "";
	return `${escapeXmlText(error.message)}${hints}`;
}

function formatEditMatchHints(details: Record<string, unknown> | undefined): string {
	if (details === undefined || !Array.isArray(details["hints"])) return "";
	const hints = details["hints"].filter(isEditMatchHint);
	if (hints.length === 0) return "";
	return `\n${hints.map((hint) => `line ${hint.line} old=${JSON.stringify(hint.old)} new=${JSON.stringify(hint.new)}`).map(escapeXmlText).join("\n")}`;
}

function formatEditNotFoundHints(details: Record<string, unknown> | undefined): string {
	if (details === undefined || !Array.isArray(details["candidates"])) return "";
	const reason = details["reason"];
	if (reason === "format_drift") {
		const candidates = details["candidates"].filter(isEditFormatCandidate);
		return formatHintLines(candidates.map((candidate) => `line ${candidate.line} old=${JSON.stringify(candidate.old)}`));
	}
	if (reason === "anchor_candidates") {
		const candidates = details["candidates"].filter(isEditAnchorCandidate);
		return formatHintLines(candidates.map((candidate) => `near line ${candidate.line} text=${JSON.stringify(candidate.text)}`));
	}
	return "";
}

function formatHintLines(lines: readonly string[]): string {
	return lines.length === 0 ? "" : `\n${lines.map(escapeXmlText).join("\n")}`;
}

function isEditFormatCandidate(value: unknown): value is { line: number; old: string } {
	return isPlainRecord(value) && typeof value["line"] === "number" && typeof value["old"] === "string";
}

function isEditAnchorCandidate(value: unknown): value is { line: number; text: string } {
	return isPlainRecord(value) && typeof value["line"] === "number" && typeof value["text"] === "string";
}

function isEditMatchHint(value: unknown): value is { line: number; old: string; new: string } {
	return isPlainRecord(value)
		&& typeof value["line"] === "number"
		&& typeof value["old"] === "string"
		&& typeof value["new"] === "string";
}

function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
