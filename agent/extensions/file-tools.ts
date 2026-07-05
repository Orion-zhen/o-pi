import {
	getLanguageFromPath,
	highlightCode,
	keyHint,
	renderDiff,
	type ExtensionAPI,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { editWorkspace, previewEditWorkspace } from "../../src/file-tools/edit-tool.js";
import { findWorkspaceFiles } from "../../src/file-tools/find-tool.js";
import { formatCompactGrepResult, grepWorkspaceFiles } from "../../src/file-tools/grep-tool.js";
import { formatGrepCall, formatGrepResult } from "../../src/file-tools/grep-renderer.js";
import { formatCompactLsResult, listWorkspaceDirectory } from "../../src/file-tools/ls-tool.js";
import { ReadVersionCache } from "../../src/file-tools/read-cache.js";
import { readWorkspaceFile } from "../../src/file-tools/read-tool.js";
import { writeWorkspaceFile } from "../../src/file-tools/write-tool.js";
import type {
	EditParams,
	EditPreviewSuccess,
	EditSuccess,
	FailedResult,
	FindDetails,
	FindParams,
	GrepParams,
	LsParams,
	LsSuccess,
	ReadParams,
	WriteParams,
} from "../../src/file-tools/types.js";

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

const lsParameters = Type.Object({ path: Type.String({ description: "Directory path." }) }, { additionalProperties: false });
const findParameters = Type.Object(
	{
		pattern: Type.String({ description: "Path glob relative to path; ** recurses." }),
		path: Type.Optional(Type.String({ description: "Search root; defaults to workspace." })),
	},
	{ additionalProperties: false },
);
const grepParameters = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			description: "Text, symbol, regex, or code intent to find.",
		}),
		path: Type.Optional(
			Type.String({
				minLength: 1,
				description: "File or directory scope; defaults to workspace.",
			}),
		),
		match: Type.Optional(
			Type.Union(
				[
					Type.Literal("auto"),
					Type.Literal("literal"),
					Type.Literal("regex"),
				],
				{
					description: "Query interpretation; defaults to auto.",
				},
			),
		),
		glob: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Relative file glob within path.",
			}),
		),
	},
	{ additionalProperties: false },
);
const readParameters = Type.Object(
	{
		path: Type.String({ description: "File path." }),
		start_line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based inclusive start line." })),
		end_line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based inclusive end line." })),
	},
	{ additionalProperties: false },
);
const writeParameters = Type.Object(
	{
		path: Type.String({ description: "File path to create or overwrite." }),
		content: Type.String({ description: "UTF-8 content to write." }),
	},
	{ additionalProperties: false },
);
const editParameters = Type.Object({
	path: Type.String({ description: "Existing file path." }),
	edits: Type.Array(
		Type.Object(
			{
				old: Type.String({
					minLength: 1,
					description: "Exact text that appears once in the original file.",
				}),
				new: Type.String({ description: "Replacement text." }),
			},
			{ additionalProperties: false },
		),
		{
			minItems: 1,
			description: "Non-overlapping replacements matched against the original file.",
		},
	),
}, { additionalProperties: false });

/** 注册覆盖版 ls/find/read/write/edit；路径权限由 Pi 进程和操作系统决定。 */
export default function fileTools(pi: ExtensionAPI): void {
	const versionCaches = new Map<string, ReadVersionCache>();

	pi.registerTool({
		name: "ls",
		label: "ls",
		description: "List direct entries of one directory; no recursion or file contents.",
		promptSnippet: "list one directory",
		parameters: lsParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await listWorkspaceDirectory(ctx.cwd, params as LsParams);
			if ("status" in result) {
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result,
				};
			}
			return {
				content: [{ type: "text", text: formatCompactLsResult(result) }],
				details: withNativeLsDetails(result),
			};
		},
	});

	pi.registerTool({
		name: "find",
		label: "find",
		description: "Find workspace files by recursive path glob; does not search file contents.",
		promptSnippet: "locate files by path",
		parameters: findParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await findWorkspaceFiles(ctx.cwd, params as FindParams, signal);
			if ("status" in result) {
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result,
				};
			}
			return {
				content: [{ type: "text", text: result.content }],
				details: withNativeFindDetails(result.details),
			};
		},
	});

	pi.registerTool({
		name: "grep",
		label: "grep",
		description: "Search code content by text, symbol, regex, or intent; return ranked syntax-aware regions.",
		promptSnippet: "locate relevant code by content or symbol",
		parameters: grepParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await grepWorkspaceFiles(ctx.cwd, params as GrepParams, signal);
			if ("status" in result) {
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result,
				};
			}
			return {
				content: [{ type: "text", text: formatCompactGrepResult(result) }],
				details: result,
			};
		},
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme));
			return text;
		},
		renderResult(result, { expanded }, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatGrepResult(result.details, expanded, theme));
			return text;
		},
	});

	pi.registerTool({
		name: "read",
		label: "read",
		description: "Read one UTF-8 file or line range and record its version for edit.",
		promptSnippet: "read file content",
		parameters: readParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const versionCache = versionCacheFor(ctx, versionCaches);
			const result = await readWorkspaceFile(ctx.cwd, params as ReadParams, { versionCache });
			return {
				content: [{ type: "text", text: JSON.stringify(scrubVersions(result), null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "write",
		label: "write",
		description: "Create or replace one file in a whole.",
		promptSnippet: "create or replace one file in a whole",
		promptGuidelines: ["Use write to create or replace a whole file."],
		parameters: writeParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await writeWorkspaceFile(ctx.cwd, params as WriteParams, signal);
			if ("status" in result && result.status === "failed") {
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result,
				};
			}
			return {
				content: [{ type: "text", text: `Successfully wrote ${result.bytes} bytes to ${result.path}` }],
				details: result,
			};
		},
		renderCall(args, theme, context) {
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
			component.setText(
				formatWriteCall(
					renderArgs,
					{ expanded: context.expanded, isPartial: context.isPartial },
					theme,
					component.cache,
					context.cwd,
				),
			);
			return component;
		},
		renderResult(result, _options, theme, context) {
			const details = result.details;
			const output = isFailedEditDetails(details) ? theme.fg("error", formatEditError(details)) : undefined;
			if (output === undefined) {
				const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
				component.clear();
				return component;
			}
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(`\n${output}`);
			return text;
		},
	});

	pi.registerTool({
		name: "edit",
		label: "edit",
		description: "Partially update one file using exact replacements; existing source files must be read first.",
		promptSnippet: "make exact replacements of one file",
		promptGuidelines: [
			"Read existing source files with read before editing them with edit.",
			"Use edit for direct file modifications to one existing file.",
		],
		parameters: editParameters,
		// 与 Pi 内置 edit 保持同一展示约定：details.diff 交给 renderDiff 渲染。
		renderShell: "self",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const versionCache = versionCacheFor(ctx, versionCaches);
			const result = await editWorkspace(ctx.cwd, params as EditParams, { versionCache });
			return {
				content: [{ type: "text", text: JSON.stringify(scrubVersions(result), null, 2) }],
				details: result,
			};
		},
		renderCall(args, theme, context) {
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
				void previewEditWorkspace(context.cwd, args).catch(previewException).then((preview) => {
					if (component.previewArgsKey === argsKey) {
						component.preview = preview;
						component.previewPending = false;
						context.invalidate();
					}
				});
			}
			return buildEditCallComponent(component, args, theme);
		},
		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0);

			const details = result.details;
			const callComponent = getEditCallComponent(context.state, undefined);
			const previewBeforeResult = callComponent.preview;
			if (isEditSuccessDetails(details)) {
				callComponent.preview = details;
				callComponent.previewArgsKey = stableArgsKey(context.args);
				callComponent.previewPending = false;
				callComponent.settledError = false;
			} else if (isFailedEditDetails(details)) {
				callComponent.settledError = true;
			}
			buildEditCallComponent(callComponent, context.args, theme);

			const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
			component.clear();
			const output = formatEditResult(details, previewBeforeResult, theme);
			if (output === undefined) return component;
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 1, 0));
			return component;
		},
	});
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

function buildEditCallComponent(component: EditCallComponent, args: unknown, theme: Theme): EditCallComponent {
	component.setBgFn(editHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme), 0, 0));
	if (component.preview === undefined) return component;

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

function formatEditResult(details: unknown, preview: EditPreview | EditSuccess | undefined, theme: Theme): string | undefined {
	if (isFailedEditDetails(details)) {
		const errorText = formatEditError(details);
		if (isFailedEditDetails(preview) && formatEditError(preview) === errorText) return undefined;
		return theme.fg("error", errorText);
	}
	if (!isEditSuccessDetails(details) || details.diff === "") return undefined;
	const previewDiff = preview !== undefined && !isFailedEditDetails(preview) ? preview.diff : undefined;
	return details.diff === previewDiff ? undefined : renderDiff(details.diff);
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
	const label = isPlainRecord(args) && typeof args["path"] === "string" ? args["path"] : "file";
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", label)}`;
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
	let text = `${theme.fg("toolTitle", theme.bold("write"))} ${formatToolPath(rawPath, theme, cwd)}`;

	if (fileContent === null) {
		text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
	} else if (fileContent.length > 0) {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const renderedLines = lang
			? (cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(fileContent)), lang))
			: normalizeDisplayText(fileContent).split("\n");
		const lines = trimTrailingEmptyLines(renderedLines);
		const totalLines = lines.length;
		const maxLines = options.expanded ? lines.length : 10;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n\n${displayLines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}
	return text;
}

function formatToolPath(rawPath: string | null, theme: Pick<Theme, "fg">, cwd: string): string {
	if (rawPath === null || rawPath.length === 0) return theme.fg("error", "?");
	const normalizedCwd = cwd.replace(/\\/g, "/");
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const display = normalizedPath.startsWith(`${normalizedCwd}/`) ? normalizedPath.slice(normalizedCwd.length + 1) : rawPath;
	return theme.fg("accent", display);
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

function isEditSuccessDetails(value: unknown): value is EditSuccess {
	return isPlainRecord(value) && value["status"] === "applied" && typeof value["diff"] === "string";
}

function isFailedEditDetails(value: unknown): value is FailedResult {
	if (!isPlainRecord(value) || value["status"] !== "failed" || !isPlainRecord(value["error"])) return false;
	const error = value["error"];
	return typeof error["code"] === "string" && typeof error["message"] === "string";
}

function versionCacheFor(ctx: { sessionManager: { getSessionId(): string } }, caches: Map<string, ReadVersionCache>): ReadVersionCache {
	const sessionId = ctx.sessionManager.getSessionId();
	const existing = caches.get(sessionId);
	if (existing !== undefined) return existing;
	const created = new ReadVersionCache();
	caches.set(sessionId, created);
	return created;
}

function scrubVersions(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(scrubVersions);
	if (value === null || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (key === "version" || key === "old_version" || key === "new_version" || key === "expected" || key === "actual") continue;
		result[key] = scrubVersions(item);
	}
	return result;
}

type NativeLsDetails = LsSuccess & {
	/** Pi 内置 ls renderer 识别的条目上限标记。 */
	entryLimitReached?: number;
};

type NativeFindDetails = FindDetails & {
	/** Pi 内置 find renderer 识别的结果上限标记。 */
	resultLimitReached?: number;
};

function withNativeLsDetails(result: LsSuccess): NativeLsDetails {
	if (!result.truncated) return result;
	return {
		...result,
		entryLimitReached: result.returned_entries ?? result.entries.length,
	};
}

function withNativeFindDetails(details: FindDetails): NativeFindDetails {
	if (!details.truncated) return details;
	return {
		...details,
		resultLimitReached: details.total,
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
