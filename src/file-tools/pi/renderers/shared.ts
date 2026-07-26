import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatToolCard } from "../../../tui/tool-card.js";
import { compactWhitespace } from "../../../tui/text.js";
import { isFailedDetails } from "../guards.js";
import type { ToolTextResult } from "./contracts.js";

export function textComponent(lastComponent: unknown): Text {
	return lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
}

export function fallbackTextResult(
	result: ToolTextResult,
	expanded: boolean,
	theme: Pick<Theme, "fg">,
	collapsedLineLimit: number,
): string {
	const output = textOutput(result).trim();
	if (output.length === 0) return "";
	const lines = output.split("\n");
	const maxLines = expanded ? lines.length : collapsedLineLimit;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
	if (remaining > 0) text += theme.fg("muted", `\n... (${remaining} more lines)`);
	return text;
}

export function formatFailureCard(
	tool: string,
	target: string,
	details: unknown,
	args: unknown,
	expanded: boolean,
	theme: Pick<Theme, "fg" | "bold">,
): string | undefined {
	if (!isFailedDetails(details)) return undefined;
	const header = formatToolCard({ tool, status: "error", target, summary: `${details.error.code}: ${details.error.message}` }, theme);
	if (!expanded) return header;
	const error = details.error;
	const rows: Array<[string, unknown]> = [
		["Call", args === undefined ? undefined : JSON.stringify(args)],
		["Error", error.code],
		["Message", error.message],
		["Path", error.path],
		["Edit", error.edit_index],
		["Expected", error.expected],
		["Actual", error.actual],
		["Next", error.next],
		["Details", error.details === undefined ? undefined : JSON.stringify(error.details)],
	];
	return [
		header,
		"",
		...rows
			.filter((row): row is [string, string | number] => row[1] !== undefined)
			.map(([label, value]) => theme.fg("toolOutput", `${label} ${compactWhitespace(String(value))}`)),
	].join("\n");
}

export function failedPath(details: unknown): string | undefined {
	if (!isFailedDetails(details)) return undefined;
	return typeof details.error.path === "string" && details.error.path.length > 0 ? details.error.path : undefined;
}

export function pathArgs(value: unknown): string[] {
	if (Array.isArray(value)) {
		const paths = value.filter((item): item is string => typeof item === "string" && item.length > 0);
		return paths.length > 0 ? paths : ["."];
	}
	return typeof value === "string" && value.length > 0 ? [value] : ["."];
}

export function displayToolPath(rawPath: string | null, cwd: string): string {
	if (rawPath === null || rawPath.length === 0) return "?";
	const normalizedCwd = (cwd || ".").replace(/\\/g, "/");
	const normalizedPath = rawPath.replace(/\\/g, "/");
	return normalizedPath.startsWith(`${normalizedCwd}/`) ? normalizedPath.slice(normalizedCwd.length + 1) : rawPath;
}

export function stringArg(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function textOutput(result: ToolTextResult): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}
