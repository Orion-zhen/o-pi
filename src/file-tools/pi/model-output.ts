import type { FailedResult } from "../shared/result.js";
import { isPlainRecord } from "./guards.js";

/** File-tool failure body; complete structured details stay outside model text. */
export function formatErrorModelResult(result: FailedResult): string {
	const hints = result.error.code === "OLD_TEXT_NOT_UNIQUE" ? formatEditMatchHints(result.error.details) : "";
	const next = result.error.next === undefined ? "" : `\nnext: ${escapeXmlText(result.error.next)}`;
	return `<error>\n${escapeXmlText(result.error.message)}${hints}${next}\n</error>`;
}

export function scrubVersions(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(scrubVersions);
	if (value === null || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (key === "version" || key === "old_version" || key === "new_version" || key === "expected" || key === "actual") continue;
		result[key] = scrubVersions(item);
	}
	return result;
}

function formatEditMatchHints(details: Record<string, unknown> | undefined): string {
	if (details === undefined || !Array.isArray(details["hints"])) return "";
	const hints = details["hints"].filter(isEditMatchHint);
	if (hints.length === 0) return "";
	return `\n${hints.map((hint) => `line ${hint.line} old=${JSON.stringify(hint.old)} new=${JSON.stringify(hint.new)}`).map(escapeXmlText).join("\n")}`;
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
