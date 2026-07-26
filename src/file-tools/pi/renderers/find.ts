import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatToolCard } from "../../../tui/tool-card.js";
import { joinParts } from "../../../tui/text.js";
import type { FindDetails } from "../../types.js";
import { isFindDetails, isPlainRecord } from "../guards.js";
import type { PartialTextRenderContext, TextRenderContext, ToolTextResult } from "./contracts.js";
import { displayToolPath, fallbackTextResult, formatFailureCard, pathArgs, stringArg, textComponent } from "./shared.js";

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
	const record = isPlainRecord(args) ? args : {};
	const query = stringArg(record["query"]);
	const rawPaths = pathArgs(record["path"]);
	return formatToolCard({
		tool: "find",
		status: "running",
		target: `${query === null ? "?" : `"${query}"`} in ${rawPaths.map((value) => displayToolPath(value, cwd)).join(", ")}`,
		summary: "locating files/directories",
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
	if (isPartial) return formatToolCard({ tool: "find", status: "running", target: findTarget(args, cwd), summary: "locating files/directories" }, theme);
	const failure = formatFailureCard("find", findTarget(args, cwd), result.details, args, expanded, theme);
	if (failure !== undefined) return failure;
	if (isFindDetails(result.details)) return formatFindDetails(result.details, expanded, theme);
	return fallbackTextResult(result, expanded, theme, 20);
}

function formatFindDetails(details: FindDetails, expanded: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	const files = details.matches.filter((match) => match.kind === "file").length;
	const directories = details.matches.filter((match) => match.kind === "directory").length;
	const summary = joinParts([
		`${details.totalMatches} ${details.totalMatches === 1 ? "match" : "matches"}`,
		`${files} ${files === 1 ? "file" : "files"}`,
		`${directories} ${directories === 1 ? "directory" : "directories"}`,
		details.strategy,
		details.nearby === undefined ? undefined : `${details.nearby.length} nearby`,
		details.related === undefined ? undefined : `${details.related.length} related`,
		details.scanTruncated ? "scan truncated" : undefined,
		details.resultLimited ? "results limited" : undefined,
		details.outputTruncated ? "output truncated" : undefined,
		details.scope_errors === undefined || details.scope_errors.length === 0 ? undefined : `${details.scope_errors.length} scope ${details.scope_errors.length === 1 ? "error" : "errors"}`,
	]);
	const scope = (details.paths ?? [details.path]).join(", ");
	const header = formatToolCard({ tool: "find", status: "success", target: `"${details.query}" in ${scope}`, summary }, theme);
	if (!expanded) return header;

	const lines = [header, ""];
	if (details.matches.length > 0) {
		lines.push("Matches:");
		for (const match of details.matches) lines.push(`${match.kind === "directory" ? `${match.path}/` : match.path} (${match.kind})`);
	}
	if (details.collapsedGroups.length > 0) {
		lines.push("", "Collapsed:");
		for (const group of details.collapsedGroups) {
			const counts = [];
			if (group.files > 0) counts.push(`${group.files} ${group.files === 1 ? "file" : "files"}`);
			if (group.directories > 0) counts.push(`${group.directories} ${group.directories === 1 ? "directory" : "directories"}`);
			lines.push(`${group.path}/** (${counts.join(", ")})`);
		}
	}
	if (details.nearby !== undefined && details.nearby.length > 0) {
		lines.push("", "Nearby (query match not guaranteed):");
		for (const result of details.nearby) lines.push(`${result.kind === "directory" ? `${result.path}/` : result.path} [${result.reason}]`);
	}
	if (details.related !== undefined && details.related.length > 0) {
		lines.push("", "Related (repo-map; query match not guaranteed):");
		for (const result of details.related) lines.push(`${result.path} [${result.relations.join(", ")}]`);
	}
	lines.push("", `Scanned ${details.scannedEntries} entries; skipped ${details.skippedCount}; ignored ${details.ignoredCount}.`);
	if (details.scanTruncated) lines.push("Scan truncated.");
	if (details.resultLimited) lines.push("Results limited.");
	if (details.outputTruncated) lines.push("Model output truncated.");
	if (details.scope_errors !== undefined && details.scope_errors.length > 0) lines.push(`Scope errors: ${details.scope_errors.map((item) => `${item.path}:${item.error.code}`).join(", ")}.`);
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
