import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatToolCard } from "../../../tui/tool-card.js";
import { joinParts } from "../../../tui/text.js";
import { isFindDetails } from "../../find/guards.js";
import type { FindDetails } from "../../find/types.js";
import { isPlainRecord } from "../../pi/guards.js";
import type { PartialTextRenderContext, TextRenderContext, ToolTextResult } from "./contracts.js";
import {
	displayToolPath,
	fallbackTextResult,
	formatFailureCard,
	pathArgs,
	stringArg,
	textComponent,
} from "./shared.js";

export function renderFindCall(
	args: unknown,
	theme: Pick<Theme, "fg" | "bold">,
	context: PartialTextRenderContext,
): Text {
	const text = textComponent(context.lastComponent);
	text.setText(context.isPartial === false ? "" : formatFindCall(args, theme, context.cwd));
	return text;
}

export function renderFindResult(
	result: ToolTextResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Pick<Theme, "fg" | "bold">,
	context: TextRenderContext,
): Text {
	const text = textComponent(context.lastComponent);
	text.setText(formatFindResult(result, options.expanded, options.isPartial, theme, context.args, context.cwd));
	return text;
}

function formatFindCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, cwd: string): string {
	return formatToolCard({
		tool: "find",
		status: "running",
		target: findTarget(args, cwd),
		summary: "fuzzy matching paths",
	}, theme);
}

function formatFindResult(
	result: ToolTextResult,
	expanded: boolean,
	isPartial: boolean,
	theme: Pick<Theme, "fg" | "bold">,
	args: unknown,
	cwd: string,
): string {
	if (isPartial) {
		return formatToolCard({
			tool: "find",
			status: "running",
			target: findTarget(args, cwd),
			summary: "fuzzy matching paths",
		}, theme);
	}
	const failure = formatFailureCard("find", findTarget(args, cwd), result.details, args, expanded, theme);
	if (failure !== undefined) return failure;
	if (isFindDetails(result.details)) return formatFindDetails(result.details, expanded, theme);
	return fallbackTextResult(result, expanded, theme, 20);
}

function formatFindDetails(
	details: FindDetails,
	expanded: boolean,
	theme: Pick<Theme, "fg" | "bold">,
): string {
	const files = details.matches.filter((match) => match.kind === "file").length;
	const directories = details.matches.length - files;
	const summary = joinParts([
		`${details.total_matches} ${details.total_matches === 1 ? "match" : "matches"}`,
		`${files} ${files === 1 ? "file" : "files"}`,
		`${directories} ${directories === 1 ? "directory" : "directories"}`,
		details.truncated_by.length === 0 ? undefined : `truncated: ${details.truncated_by.join(", ")}`,
		details.scope_errors === undefined || details.scope_errors.length === 0
			? undefined
			: `${details.scope_errors.length} scope ${details.scope_errors.length === 1 ? "error" : "errors"}`,
	]);
	const scope = details.paths.join(", ");
	const target = joinParts([
		`"${details.query}" in ${scope}`,
		details.glob === undefined ? undefined : `glob ${details.glob}`,
	]);
	const header = formatToolCard({ tool: "find", status: "success", target, summary }, theme);
	if (!expanded) return header;

	const lines = [header, ""];
	if (details.matches.length > 0) {
		lines.push("Matches:");
		for (const match of details.matches) {
			lines.push(`${match.kind === "directory" ? `${match.path}/` : match.path} (${match.kind})`);
		}
	}
	lines.push(
		"",
		`Traversed ${details.stats.traversed_entries}; ignored ${details.stats.ignored_entries}; skipped ${details.stats.skipped_entries}.`,
	);
	if (details.truncated_by.length > 0) lines.push(`Truncated: ${details.truncated_by.join(", ")}.`);
	if (details.scope_errors !== undefined && details.scope_errors.length > 0) {
		lines.push(`Scope errors: ${details.scope_errors.map((item) => `${item.path}:${item.error.code}`).join(", ")}.`);
	}
	return lines.map((line) => line === header ? line : theme.fg("toolOutput", line)).join("\n");
}

function findTarget(args: unknown, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	const query = stringArg(record["query"]);
	const rawPaths = pathArgs(record["path"]);
	const glob = stringArg(record["glob"]);
	return joinParts([
		`${query === null ? "?" : `"${query}"`} in ${rawPaths.map((value) => displayToolPath(value, cwd)).join(", ")}`,
		glob === null ? undefined : `glob ${glob}`,
	]);
}
