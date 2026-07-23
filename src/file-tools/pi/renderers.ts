import {
	getLanguageFromPath,
	highlightCode,
	renderDiff,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { formatToolCard } from "../../tui/tool-card.js";
import { compactWhitespace, formatBytes, formatChars, joinParts } from "../../tui/text.js";
import { formatGrepCall, formatGrepResult } from "../grep/renderer.js";
import {
	isEditSuccessDetails,
	isFailedDetails,
	isFailedEditDetails,
	isFindDetails,
	isLsSuccess,
	isPlainRecord,
	isReadFileSuccess,
	isReadImageSuccess,
	isReadSuccess,
	isWriteSuccess,
} from "./guards.js";
import type {
	EditPreviewSuccess,
	EditSuccess,
	FailedResult,
	FindDetails,
	LspDiagnosticsSummary,
	ReadImageSuccess,
	ReadSuccess,
} from "../types.js";

type ToolTextResult = { content: Array<{ type: string; text?: string }>; details?: unknown };
type ToolReadResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown };
type TextRenderContext = { lastComponent?: unknown; cwd: string; args?: unknown };
type PartialTextRenderContext = TextRenderContext & { isPartial?: boolean };
type WriteRenderContext = TextRenderContext & { expanded: boolean; isPartial: boolean; argsComplete: boolean };
type EditCallContext = {
	lastComponent?: unknown;
	state: { callComponent?: EditCallComponent };
	argsComplete: boolean;
	cwd: string;
	expanded: boolean;
	isPartial: boolean;
	invalidate(): void;
};
type EditResultContext = {
	lastComponent?: unknown;
	state: { callComponent?: EditCallComponent };
	args: unknown;
};

type EditPreview = EditPreviewSuccess | FailedResult;
type EditCallComponent = Box & {
	preview: EditPreview | EditSuccess | undefined;
	previewArgsKey: string | undefined;
	previewPending: boolean;
	settledError: boolean;
};
type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};
type WriteCallComponent = Text & {
	cache: WriteHighlightCache | undefined;
};

export function renderLsCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, context: PartialTextRenderContext): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(context.isPartial === false ? "" : formatLsCall(args, theme, context.cwd));
	return text;
}

export function renderLsResult(result: ToolTextResult, options: { expanded: boolean; isPartial: boolean }, theme: Pick<Theme, "fg" | "bold">, context: TextRenderContext): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(formatLsResult(result, options.expanded, options.isPartial, theme, context.args, context.cwd));
	return text;
}

export function renderFindCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, context: PartialTextRenderContext): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(context.isPartial === false ? "" : formatFindCall(args, theme, context.cwd));
	return text;
}

export function renderFindResult(result: ToolTextResult, options: { expanded: boolean; isPartial: boolean }, theme: Pick<Theme, "fg" | "bold">, context: TextRenderContext): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(formatFindResult(result, options.expanded, options.isPartial, theme, context.args, context.cwd));
	return text;
}

export function renderGrepCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, context: { lastComponent?: unknown; isPartial?: boolean }): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(context.isPartial === false ? "" : formatGrepCall(args, theme));
	return text;
}

export function renderGrepResult(result: ToolTextResult, options: { expanded: boolean }, theme: Pick<Theme, "fg" | "bold">, context: { lastComponent?: unknown; args?: unknown }): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(formatFailureCard("grep", grepTarget(context.args), result.details, context.args, options.expanded, theme) ?? formatGrepResult(result.details, options.expanded, theme));
	return text;
}

export function renderReadCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, context: PartialTextRenderContext): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(context.isPartial === false ? "" : formatReadCall(args, theme, context.cwd));
	return text;
}

export function renderReadResult(result: ToolReadResult, options: { expanded: boolean; isPartial: boolean }, theme: Pick<Theme, "fg" | "bold">, context: TextRenderContext): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(formatReadResult(result, options.expanded, options.isPartial, theme, context.args, context.cwd));
	return text;
}

export function renderWriteCall(args: unknown, theme: Theme, context: WriteRenderContext): Text {
	if (context.isPartial === false) return new Text("", 0, 0);
	const renderArgs = args as { path?: string; file_path?: string; content?: string } | undefined;
	const rawPath = stringArg(renderArgs?.file_path ?? renderArgs?.path);
	const fileContent = stringArg(renderArgs?.content);
	const component = getWriteCallComponent(context.lastComponent);
	if (fileContent !== null) {
		component.cache = context.argsComplete
			? rebuildWriteHighlightCacheFull(rawPath, fileContent)
			: updateWriteHighlightCacheIncremental(component.cache, rawPath, fileContent);
	} else {
		component.cache = undefined;
	}
	component.setText(formatWriteCall(renderArgs, { expanded: context.expanded, isPartial: context.isPartial }, theme, component.cache, context.cwd));
	return component;
}

export function renderWriteResult(result: { details?: unknown }, options: { expanded: boolean }, theme: Pick<Theme, "fg" | "bold">, context: TextRenderContext): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(formatWriteResult(result.details, theme, context.args, context.cwd, options.expanded));
	return text;
}

export function renderEditCall(args: unknown, theme: Theme, context: EditCallContext): Text | EditCallComponent {
	if (context.isPartial === false) return new Text("", 0, 0);
	const component = getEditCallComponent(context.state, context.lastComponent);
	const argsKey = stableArgsKey(args);
	if (component.previewArgsKey !== argsKey) {
		component.preview = undefined;
		component.previewArgsKey = argsKey;
		component.previewPending = false;
		component.settledError = false;
	}
	if (context.argsComplete && argsKey !== undefined && component.preview === undefined && !component.previewPending) {
		component.previewPending = true;
		void import("../tools/edit.js")
			.then(({ previewEditWorkspace }) => previewEditWorkspace(context.cwd, args))
			.catch(previewException)
			.then((preview) => {
				if (component.previewArgsKey === argsKey) {
					component.preview = preview;
					component.previewPending = false;
					context.invalidate();
				}
			});
	}
	return buildEditCallComponent(component, args, theme, context.expanded);
}

export function renderEditResult(result: { details?: unknown }, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: EditResultContext): Text | Box {
	if (options.isPartial) return new Text(formatToolCard({ tool: "edit", status: "running", target: editTarget(context.args), summary: "applying" }, theme), 0, 0);

	const details = result.details;
	const callComponent = getEditCallComponent(context.state, undefined);
	if (isEditSuccessDetails(details)) {
		callComponent.preview = details;
		callComponent.previewArgsKey = stableArgsKey(context.args);
		callComponent.previewPending = false;
		callComponent.settledError = false;
	} else if (isFailedEditDetails(details)) {
		callComponent.settledError = true;
	}
	buildEditCallComponent(callComponent, context.args, theme, options.expanded);

	const component = context.lastComponent instanceof Box ? context.lastComponent : new Box(1, 1);
	component.clear();
	component.setBgFn(editResultBg(details, theme));
	const output = formatEditResult(details, theme, context.args, options.expanded);
	if (output === undefined) return component;
	component.addChild(new Text(output, 0, 0));
	return component;
}

function createEditCallComponent(): EditCallComponent {
	return Object.assign(new Box(1, 1), {
		preview: undefined,
		previewArgsKey: undefined,
		previewPending: false,
		settledError: false,
	});
}

function getEditCallComponent(state: { callComponent?: EditCallComponent }, lastComponent: unknown): EditCallComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as EditCallComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent !== undefined) return state.callComponent;
	const component = createEditCallComponent();
	state.callComponent = component;
	return component;
}

function buildEditCallComponent(component: EditCallComponent, args: unknown, theme: Theme, expanded: boolean): EditCallComponent {
	component.setBgFn(editHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme), 0, 0));
	if (!expanded || component.preview === undefined) return component;

	component.addChild(new Spacer(1));
	if (isFailedEditDetails(component.preview)) {
		component.addChild(new Text(theme.fg("error", formatEditError(component.preview)), 0, 0));
	} else if (component.preview.diff !== "") {
		component.addChild(new Text(renderDiff(component.preview.diff), 0, 0));
	}
	return component;
}

function editHeaderBg(preview: EditPreview | EditSuccess | undefined, settledError: boolean, theme: Theme): ((text: string) => string) | undefined {
	if (preview !== undefined) {
		return isFailedEditDetails(preview) ? (text) => theme.bg("toolErrorBg", text) : (text) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) return (text) => theme.bg("toolErrorBg", text);
	return (text) => theme.bg("toolPendingBg", text);
}

function editResultBg(details: unknown, theme: Theme): (text: string) => string {
	if (isFailedEditDetails(details)) return (text) => theme.bg("toolErrorBg", text);
	if (isEditSuccessDetails(details)) return (text) => theme.bg("toolSuccessBg", text);
	return (text) => theme.bg("toolPendingBg", text);
}

function formatEditResult(details: unknown, theme: Theme, args: unknown, expanded: boolean): string | undefined {
	if (isFailedEditDetails(details)) return formatFailureCard("edit", editTarget(args), details, args, expanded, theme);
	if (!isEditSuccessDetails(details)) return undefined;
	const header = formatToolCard({
		tool: "edit",
		status: "success",
		target: details.path,
		summary: joinParts([formatDiffStats(details.diff), `${details.replacements} replacements`, details.diff !== "" ? "diff available" : "no diff", formatLspSummary(details.lsp?.diagnostics)]),
	}, theme);
	const diff = details.diff === "" ? undefined : renderDiff(details.diff);
	if (!expanded) return header;
	const diagnostics = formatLspDiagnostics(details.lsp?.diagnostics, theme);
	return [header, diff, diagnostics].filter((part): part is string => part !== undefined).join("\n\n");
}

function stableArgsKey(args: unknown): string | undefined {
	if (!isPlainRecord(args) || typeof args["path"] !== "string" || !Array.isArray(args["edits"])) return undefined;
	return JSON.stringify({ path: args["path"], edits: args["edits"] });
}

function formatEditError(result: FailedResult): string {
	return `${result.error.code}: ${result.error.message}`;
}

function previewException(error: unknown): FailedResult {
	return {
		status: "failed",
		error: {
			code: "INVALID_OPERATION",
			message: error instanceof Error ? error.message : String(error),
		},
	};
}

function formatEditCall(args: unknown, theme: Pick<Theme, "fg" | "bold">): string {
	const replacements = isPlainRecord(args) && Array.isArray(args["edits"]) ? args["edits"].length : undefined;
	return formatToolCard({
		tool: "edit",
		status: "running",
		target: editTarget(args),
		summary: joinParts(["previewing", replacements !== undefined ? `${replacements} replacements` : undefined]),
	}, theme);
}

function getWriteCallComponent(lastComponent: unknown): WriteCallComponent {
	return lastComponent instanceof Text ? (lastComponent as WriteCallComponent) : Object.assign(new Text("", 0, 0), { cache: undefined });
}

const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

function highlightSingleLine(line: string, lang: string): string {
	return highlightCode(line, lang)[0] ?? "";
}

function refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
	const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
	if (prefixCount === 0) return;
	const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
	const prefixHighlighted = highlightCode(prefixSource, cache.lang);
	for (let index = 0; index < prefixCount; index += 1) {
		cache.highlightedLines[index] = prefixHighlighted[index] ?? highlightSingleLine(cache.normalizedLines[index] ?? "", cache.lang);
	}
}

function rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	const normalized = replaceTabs(normalizeDisplayText(fileContent));
	return {
		rawPath,
		lang,
		rawContent: fileContent,
		normalizedLines: normalized.split("\n"),
		highlightedLines: highlightCode(normalized, lang),
	};
}

function updateWriteHighlightCacheIncremental(
	cache: WriteHighlightCache | undefined,
	rawPath: string | null,
	fileContent: string,
): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	if (cache === undefined) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (cache.lang !== lang || cache.rawPath !== rawPath) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (!fileContent.startsWith(cache.rawContent)) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (fileContent.length === cache.rawContent.length) return cache;

	const deltaNormalized = replaceTabs(normalizeDisplayText(fileContent.slice(cache.rawContent.length)));
	cache.rawContent = fileContent;
	if (cache.normalizedLines.length === 0) {
		cache.normalizedLines.push("");
		cache.highlightedLines.push("");
	}

	const segments = deltaNormalized.split("\n");
	const lastIndex = cache.normalizedLines.length - 1;
	cache.normalizedLines[lastIndex] += segments[0] ?? "";
	cache.highlightedLines[lastIndex] = highlightSingleLine(cache.normalizedLines[lastIndex] ?? "", cache.lang);
	for (let index = 1; index < segments.length; index += 1) {
		const segment = segments[index] ?? "";
		cache.normalizedLines.push(segment);
		cache.highlightedLines.push(highlightSingleLine(segment, cache.lang));
	}
	refreshWriteHighlightPrefix(cache);
	return cache;
}

function formatWriteCall(
	args: { path?: string; file_path?: string; content?: string } | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
	cache: WriteHighlightCache | undefined,
	cwd: string,
): string {
	const rawPath = stringArg(args?.file_path ?? args?.path);
	const fileContent = stringArg(args?.content);
	const target = displayToolPath(rawPath, cwd);

	if (fileContent === null) return formatToolCard({ tool: "write", status: "error", target, summary: "invalid content arg" }, theme);
	const lineCount = fileContent === "" ? 0 : fileContent.split(/\r\n?|\n/).length;
	const header = formatToolCard({
		tool: "write",
		status: "running",
		target,
		summary: joinParts([`${lineCount} lines`, formatChars(fileContent.length), options.expanded ? "preview" : "preview hidden"]),
	}, theme);
	if (!options.expanded || fileContent.length === 0) return header;

	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang
		? (cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(fileContent)), lang))
		: normalizeDisplayText(fileContent).split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	return `${header}\n\n${lines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
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

function formatFindResult(result: ToolTextResult, expanded: boolean, isPartial: boolean, theme: Pick<Theme, "fg" | "bold">, args: unknown, cwd: string): string {
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
	if (details.scope_errors !== undefined && details.scope_errors.length > 0) lines.push(`Scope errors: ${details.scope_errors.map((item) => item.path).join(", ")}.`);
	return lines.map((line) => line === header ? line : theme.fg("toolOutput", line)).join("\n");
}

function formatLsCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	const rawPath = stringArg(record["path"]) ?? ".";
	return formatToolCard({ tool: "ls", status: "running", target: displayToolPath(rawPath, cwd), summary: "listing directory" }, theme);
}

function formatLsResult(result: ToolTextResult, expanded: boolean, isPartial: boolean, theme: Pick<Theme, "fg" | "bold">, args: unknown, cwd: string): string {
	const target = isLsSuccess(result.details) ? result.details.path : failedPath(result.details) ?? lsTarget(args, cwd);
	if (isPartial) return formatToolCard({ tool: "ls", status: "running", target, summary: "listing directory" }, theme);
	const failure = formatFailureCard("ls", target, result.details, args, expanded, theme);
	if (failure !== undefined) return failure;
	if (!isLsSuccess(result.details)) return fallbackTextResult(result, expanded, theme, 20);
	const details = result.details;
	const dirs = details.entries.filter((entry) => entry.type === "directory").length;
	const files = details.entries.filter((entry) => entry.type === "file").length;
	const total = details.total_entries ?? details.returned_entries ?? details.entries.length;
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

function formatReadCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	const rawPath = stringArg(record["path"]);
	const range = typeof record["start_line"] === "number" || typeof record["end_line"] === "number"
		? `lines ${record["start_line"] ?? 1}-${record["end_line"] ?? "end"}`
		: "file";
	return formatToolCard({ tool: "read", status: "running", target: displayToolPath(rawPath, cwd), summary: range }, theme);
}

function formatReadResult(result: ToolReadResult, expanded: boolean, isPartial: boolean, theme: Pick<Theme, "fg" | "bold">, args: unknown, cwd: string): string {
	const target = isReadFileSuccess(result.details) ? result.details.path : readTarget(args, cwd);
	if (isPartial) return formatToolCard({ tool: "read", status: "running", target, summary: "reading file" }, theme);
	const failure = formatFailureCard("read", target, result.details, args, expanded, theme);
	if (failure !== undefined) return failure;
	if (isReadImageSuccess(result.details)) return formatReadImageResult(result.details, expanded, theme);
	if (!isReadSuccess(result.details)) return fallbackTextResult(result, expanded, theme, 10);
	return formatReadTextResult(result.details, expanded, theme);
}

function formatReadImageResult(details: ReadImageSuccess, expanded: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	const header = formatToolCard({
		tool: "read",
		status: "success",
		target: details.path,
		summary: joinParts(["image", details.image.mime_type, formatBytes(details.size_bytes), "attached"]),
	}, theme);
	if (!expanded) return header;
	return `${header}\n\n${theme.fg("toolOutput", details.content)}`;
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

function formatWriteResult(details: unknown, theme: Pick<Theme, "fg" | "bold">, args: unknown, cwd: string, expanded: boolean): string {
	const target = isWriteSuccess(details) ? details.path : writeTarget(args, cwd);
	const failure = formatFailureCard("write", target, details, args, expanded, theme);
	if (failure !== undefined) return failure;
	if (!isWriteSuccess(details)) return formatToolCard({ tool: "write", status: "neutral", target, summary: "waiting" }, theme);
	const diff = typeof details.diff === "string" ? details.diff : "";
	const header = formatToolCard({
		tool: "write",
		status: "success",
		target: details.path,
		summary: joinParts([formatDiffStats(diff), formatBytes(details.bytes), diff !== "" ? "diff available" : "no diff", formatLspSummary(details.lsp?.diagnostics)]),
	}, theme);
	const renderedDiff = diff === "" ? undefined : renderDiff(diff);
	if (!expanded) return header;
	const diagnostics = formatLspDiagnostics(details.lsp?.diagnostics, theme);
	return [header, renderedDiff, diagnostics].filter((part): part is string => part !== undefined).join("\n\n");
}

function fallbackTextResult(result: ToolTextResult, expanded: boolean, theme: Pick<Theme, "fg">, collapsedLineLimit: number): string {
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

function textOutput(result: ToolTextResult): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

function formatFailureCard(tool: string, target: string, details: unknown, args: unknown, expanded: boolean, theme: Pick<Theme, "fg" | "bold">): string | undefined {
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

function failedPath(details: unknown): string | undefined {
	if (!isFailedDetails(details)) return undefined;
	return typeof details.error.path === "string" && details.error.path.length > 0 ? details.error.path : undefined;
}

function grepTarget(args: unknown): string {
	const record = isPlainRecord(args) ? args : {};
	const query = typeof record["query"] === "string" ? JSON.stringify(record["query"]) : "?";
	const scope = typeof record["path"] === "string" && record["path"].length > 0 ? record["path"] : ".";
	return `${query} in ${scope}`;
}

function pathArgs(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0);
	return typeof value === "string" && value.length > 0 ? [value] : ["."];
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

function readTarget(args: unknown, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	return displayToolPath(stringArg(record["path"]), cwd);
}

function lsTarget(args: unknown, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	return displayToolPath(stringArg(record["path"]) ?? ".", cwd);
}

function writeTarget(args: unknown, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	return displayToolPath(stringArg(record["file_path"] ?? record["path"]), cwd);
}

function editTarget(args: unknown): string {
	return isPlainRecord(args) && typeof args["path"] === "string" && args["path"].length > 0 ? args["path"] : "file";
}

function displayToolPath(rawPath: string | null, cwd: string): string {
	if (rawPath === null || rawPath.length === 0) return "?";
	const normalizedCwd = (cwd || ".").replace(/\\/g, "/");
	const normalizedPath = rawPath.replace(/\\/g, "/");
	return normalizedPath.startsWith(`${normalizedCwd}/`) ? normalizedPath.slice(normalizedCwd.length + 1) : rawPath;
}

function formatDiffStats(diff: string): string {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
	}
	return `+${added} -${removed}`;
}

function formatLspSummary(diagnostics: LspDiagnosticsSummary | undefined): string | undefined {
	if (!hasVisibleLspDiagnostics(diagnostics)) return undefined;
	return diagnostics.status === "errors"
		? `LSP ${diagnostics.file_errors} errors`
		: `LSP ${diagnostics.file_warnings} warnings`;
}

function formatLspDiagnostics(diagnostics: LspDiagnosticsSummary | undefined, theme: Pick<Theme, "fg">): string | undefined {
	if (!hasVisibleLspDiagnostics(diagnostics) || (diagnostics.items.length === 0 && diagnostics.total_items === 0)) return undefined;
	const lines = diagnostics.items.map((item) => theme.fg("toolOutput", `${item.severity} ${item.line}:${item.column} ${item.message}${item.code !== undefined ? ` (${item.code})` : ""}`));
	const remaining = Math.max(0, diagnostics.total_items - diagnostics.items.length);
	if (remaining > 0) lines.push(theme.fg("toolOutput", `... ${remaining} more diagnostics`));
	return lines.join("\n");
}

function hasVisibleLspDiagnostics(diagnostics: LspDiagnosticsSummary | undefined): diagnostics is LspDiagnosticsSummary & { status: "errors" | "warnings" } {
	return diagnostics?.status === "errors" || diagnostics?.status === "warnings";
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end -= 1;
	return lines.slice(0, end);
}

function normalizeDisplayText(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function replaceTabs(value: string): string {
	return value.replace(/\t/g, "    ");
}

function stringArg(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}
