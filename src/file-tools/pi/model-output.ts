import type { FailedResult } from "../shared/result.js";
import { isPlainRecord } from "./guards.js";

/** File-tool failure body; complete structured details stay outside model text. */
export function formatErrorModelResult(result: FailedResult): string {
	const hints = result.error.code === "OLD_TEXT_NOT_UNIQUE"
		? formatEditMatchHints(result.error.details)
		: result.error.code === "OLD_TEXT_NOT_FOUND"
			? formatEditNotFoundHints(result.error.details)
			: "";
	const next = result.error.next === undefined ? "" : `\nnext: ${escapeXmlText(result.error.next)}`;
	return `<error>\n${escapeXmlText(result.error.message)}${hints}${next}\n</error>`;
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
