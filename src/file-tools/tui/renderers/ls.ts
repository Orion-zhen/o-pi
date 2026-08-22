import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatToolCard } from "../../../tui/tool-card.js";
import { joinParts } from "../../../tui/text.js";
import { isLsSuccess } from "../../ls/guards.js";
import { isPlainRecord } from "../../pi/guards.js";
import type { PartialTextRenderContext, TextRenderContext, ToolTextResult } from "./contracts.js";
import { displayToolPath, failedPath, fallbackTextResult, formatFailureCard, stringArg, textComponent } from "./shared.js";

export function renderLsCall(
	args: unknown,
	theme: Pick<Theme, "fg" | "bold">,
	context: PartialTextRenderContext,
): Text {
	const text = textComponent(context.lastComponent);
	text.setText(context.isPartial === false ? "" : formatLsCall(args, theme, context.cwd));
	return text;
}

export function renderLsResult(
	result: ToolTextResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Pick<Theme, "fg" | "bold">,
	context: TextRenderContext,
): Text {
	const text = textComponent(context.lastComponent);
	text.setText(formatLsResult(result, options.expanded, options.isPartial, theme, context.args, context.cwd));
	return text;
}

function formatLsCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	const rawPath = stringArg(record["path"]) ?? ".";
	return formatToolCard({ tool: "ls", status: "running", target: displayToolPath(rawPath, cwd), summary: "listing directory" }, theme);
}

function formatLsResult(
	result: ToolTextResult,
	expanded: boolean,
	isPartial: boolean,
	theme: Pick<Theme, "fg" | "bold">,
	args: unknown,
	cwd: string,
): string {
	const target = isLsSuccess(result.details) ? result.details.path : failedPath(result.details) ?? lsTarget(args, cwd);
	if (isPartial) return formatToolCard({ tool: "ls", status: "running", target, summary: "listing directory" }, theme);
	const failure = formatFailureCard("ls", target, result.details, args, expanded, theme);
	if (failure !== undefined) return failure;
	if (!isLsSuccess(result.details)) return fallbackTextResult(result, expanded, theme, 20);
	const details = result.details;
	const dirs = details.entries.filter((entry) => entry.type === "directory").length;
	const files = details.entries.filter((entry) => entry.type === "file").length;
	const total = details.truncated ? details.total_entries : details.entries.length;
	const header = formatToolCard({
		tool: "ls",
		status: "success",
		target: details.path,
		summary: joinParts([`${total} entries`, `${dirs} dirs`, `${files} files`, details.truncated ? "truncated" : undefined]),
	}, theme);
	if (!expanded) return header;
	const lines = details.entries.map((entry) => {
		const suffix = entry.type === "directory" ? "/" : entry.type === "symlink" && entry.link_target ? ` -> ${entry.link_target}` : "";
		return `${entry.path}${suffix}`;
	});
	return [header, "", ...lines.map((line) => theme.fg("toolOutput", line))].join("\n");
}

function lsTarget(args: unknown, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	return displayToolPath(stringArg(record["path"]) ?? ".", cwd);
}
