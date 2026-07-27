import {
	getLanguageFromPath,
	highlightCode,
	renderDiff,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatToolCard } from "../../../tui/tool-card.js";
import { formatBytes, formatChars, joinParts } from "../../../tui/text.js";
import { isWriteSuccess } from "../../write/guards.js";
import { isPlainRecord } from "../guards.js";
import { isMutationProgress, type MutationPostProcessProgressDetails } from "../progress.js";
import type { TextRenderContext } from "./contracts.js";
import { formatDiffStats, formatLspDiagnostics, formatLspSummary, formatMutationPostProcessSummary } from "./diagnostics.js";
import { displayToolPath, formatFailureCard, stringArg, textComponent } from "./shared.js";

interface WriteRendererState {
	callComponent?: WriteCallComponent;
}

interface WriteRenderContext extends TextRenderContext {
	expanded: boolean;
	isPartial: boolean;
	argsComplete: boolean;
	state: WriteRendererState;
}

interface WriteHighlightCache {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
}

class WriteCallComponent extends Text {
	cache: WriteHighlightCache | undefined;
	phase: "writing" = "writing";
	postProcess: MutationPostProcessProgressDetails | undefined;
	progressDiff: string | undefined;
	argsPath: string | null = null;
	argsContent: string | null = null;

	constructor() {
		super("", 0, 0);
	}
}

const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

export function renderWriteCall(args: unknown, theme: Theme, context: WriteRenderContext): Text {
	if (context.isPartial === false) return new Text("", 0, 0);
	const renderArgs = writeArgs(args);
	const rawPath = stringArg(renderArgs?.file_path ?? renderArgs?.path);
	const fileContent = stringArg(renderArgs?.content);
	const component = getWriteCallComponent(context.state, context.lastComponent);
	if (component.argsPath !== rawPath || component.argsContent !== fileContent) {
		component.argsPath = rawPath;
		component.argsContent = fileContent;
		component.phase = "writing";
		component.postProcess = undefined;
		component.progressDiff = undefined;
	}
	if (fileContent !== null) {
		component.cache = context.argsComplete
			? rebuildWriteHighlightCacheFull(rawPath, fileContent)
			: updateWriteHighlightCacheIncremental(component.cache, rawPath, fileContent);
	} else {
		component.cache = undefined;
	}
	component.setText(formatWriteCall(component, renderArgs, { expanded: context.expanded, isPartial: context.isPartial }, theme, component.cache, context.cwd));
	return component;
}

export function renderWriteResult(
	result: { details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: TextRenderContext & { state: WriteRendererState },
): Text {
	if (options.isPartial) {
		const component = getWriteCallComponent(context.state, undefined);
		if (isMutationProgress(result.details)) {
			if (result.details.status === "writing") component.postProcess = undefined;
			else if (result.details.status === "post-processing") component.postProcess = result.details;
			if (result.details.diff !== undefined) component.progressDiff = result.details.diff;
		}
		const args = writeArgs(context.args);
		component.setText(formatWriteCall(component, args, { expanded: options.expanded, isPartial: true }, theme, component.cache, context.cwd));
		const partial = textComponent(context.lastComponent);
		partial.setText("");
		return partial;
	}
	const text = textComponent(context.lastComponent);
	text.setText(formatWriteResult(result.details, theme, context.args, context.cwd, options.expanded));
	return text;
}

function getWriteCallComponent(state: WriteRendererState, lastComponent: unknown): WriteCallComponent {
	if (lastComponent instanceof WriteCallComponent) state.callComponent = lastComponent;
	state.callComponent ??= new WriteCallComponent();
	return state.callComponent;
}

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
	component: WriteCallComponent,
	args: { path?: string; file_path?: string; content?: string } | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
	cache: WriteHighlightCache | undefined,
	cwd: string,
): string {
	const rawPath = stringArg(args?.file_path ?? args?.path);
	const fileContent = stringArg(args?.content);
	const target = displayToolPath(rawPath, cwd);

	const progressSummary = component.postProcess === undefined ? component.phase : formatMutationPostProcessSummary(component.postProcess);
	if (fileContent === null) return formatToolCard({ tool: "write", status: "running", target, summary: progressSummary }, theme);
	const lineCount = fileContent === "" ? 0 : fileContent.split(/\r\n?|\n/).length;
	const header = formatToolCard({
		tool: "write",
		status: "running",
		target,
		summary: joinParts([progressSummary, component.progressDiff === undefined ? undefined : formatDiffStats(component.progressDiff), `${lineCount} lines`, formatChars(fileContent.length)]),
	}, theme);
	if (!options.expanded || fileContent.length === 0) return header;

	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang
		? (cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(fileContent)), lang))
		: normalizeDisplayText(fileContent).split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	return `${header}\n\n${lines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
}

function formatWriteResult(
	details: unknown,
	theme: Pick<Theme, "fg" | "bold">,
	args: unknown,
	cwd: string,
	expanded: boolean,
): string {
	const target = isWriteSuccess(details) ? details.path : writeTarget(args, cwd);
	const failure = formatFailureCard("write", target, details, args, expanded, theme);
	if (failure !== undefined) return failure;
	if (!isWriteSuccess(details)) return formatToolCard({ tool: "write", status: "neutral", target, summary: "waiting" }, theme);
	const diff = typeof details.diff === "string" ? details.diff : "";
	const header = formatToolCard({
		tool: "write",
		status: "success",
		target: details.path,
		summary: joinParts(["done", formatDiffStats(diff), formatBytes(details.bytes), formatLspSummary(details.lsp?.diagnostics)]),
	}, theme);
	const renderedDiff = diff === "" ? undefined : renderDiff(diff);
	if (!expanded) return header;
	const diagnostics = formatLspDiagnostics(details.lsp?.diagnostics, theme);
	return [header, renderedDiff, diagnostics].filter((part): part is string => part !== undefined).join("\n\n");
}

function writeTarget(args: unknown, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	return displayToolPath(stringArg(record["file_path"] ?? record["path"]), cwd);
}

function writeArgs(args: unknown): { path?: string; file_path?: string; content?: string } | undefined {
	if (!isPlainRecord(args)) return undefined;
	return {
		...(typeof args["path"] === "string" ? { path: args["path"] } : {}),
		...(typeof args["file_path"] === "string" ? { file_path: args["file_path"] } : {}),
		...(typeof args["content"] === "string" ? { content: args["content"] } : {}),
	};
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
