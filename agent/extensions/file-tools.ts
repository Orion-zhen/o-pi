import {
	getLanguageFromPath,
	highlightCode,
	keyHint,
	renderDiff,
	type ExtensionAPI,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { editWorkspace, previewEditWorkspace } from "../../src/file-tools/edit-tool.js";
import { findWorkspaceFiles } from "../../src/file-tools/find-tool.js";
import { formatCompactGrepResult, grepWorkspaceFiles } from "../../src/file-tools/grep-tool.js";
import { formatGrepCall, formatGrepResult } from "../../src/file-tools/grep-renderer.js";
import { formatCompactLsResult, listWorkspaceDirectory } from "../../src/file-tools/ls-tool.js";
import { ReadVersionCache } from "../../src/file-tools/read-cache.js";
import { readWorkspaceFile } from "../../src/file-tools/read-tool.js";
import { writeWorkspaceFile } from "../../src/file-tools/write-tool.js";
import { formatToolCard } from "../../src/tui/tool-card.js";
import { formatBytes, formatChars, joinParts } from "../../src/tui/text.js";
import { lspFileHooks } from "../../src/lsp/index.js";
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
	LspEnclosingSymbol,
	ReadParams,
	ReadSuccess,
	WriteSuccess,
	WriteParams,
	LspDiagnosticsSummary,
	LspOutlineItem,
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
		query: Type.String({
			minLength: 1,
			description: "File or directory name, path fragment, or glob; use ** for recursive find.",
		}),
		path: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Search root; defaults to workspace.",
			}),
		),
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
			if (isFailedDetails(result)) {
				return {
					content: [{ type: "text", text: formatErrorModelResult("ls", result) }],
					details: result,
				};
			}
			return {
				content: [{ type: "text", text: formatCompactLsResult(result) }],
				details: withNativeLsDetails(result),
			};
		},
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(context.isPartial === false ? "" : formatLsCall(args, theme, context.cwd));
			return text;
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatLsResult(result, expanded, isPartial, theme, context.cwd));
			return text;
		},
	});

	pi.registerTool({
		name: "find",
		label: "find",
		description: "Find files or directories by name, path fragment, or glob; does not search contents.",
		promptSnippet: "locate files or directories by path",
		parameters: findParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await findWorkspaceFiles(ctx.cwd, params as FindParams, signal);
			if (isFailedDetails(result)) {
				return {
					content: [{ type: "text", text: formatErrorModelResult("find", result) }],
					details: result,
				};
			}
			return {
				content: [{ type: "text", text: result.content }],
				details: result.details,
			};
		},
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(context.isPartial === false ? "" : formatFindCall(args, theme, context.cwd));
			return text;
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatFindResult(result, expanded, isPartial, theme, context.args, context.cwd));
			return text;
		},
	});

	pi.registerTool({
		name: "grep",
		label: "grep",
		description: "Search code content by text, symbol, regex, or intent; return ranked syntax-aware regions.",
		promptSnippet: "locate relevant code by content or symbol",
		parameters: grepParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await grepWorkspaceFiles(ctx.cwd, params as GrepParams, signal, { lsp: lspFileHooks });
			if (isFailedDetails(result)) {
				return {
					content: [{ type: "text", text: formatErrorModelResult("grep", result) }],
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
			text.setText(context.isPartial === false ? "" : formatGrepCall(args, theme));
			return text;
		},
		renderResult(result, { expanded }, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatFailureCard("grep", grepTarget(context.args), result.details, theme) ?? formatGrepResult(result.details, expanded, theme));
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
			const result = await readWorkspaceFile(ctx.cwd, params as ReadParams, { versionCache, lsp: lspFileHooks });
			const text = isReadSuccess(result)
				? formatReadModelResult(result)
				: isFailedDetails(result)
					? formatErrorModelResult("read", result)
					: JSON.stringify(scrubVersions(result));
			return {
				content: [{ type: "text", text }],
				details: result,
			};
		},
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(context.isPartial === false ? "" : formatReadCall(args, theme, context.cwd));
			return text;
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatReadResult(result, expanded, isPartial, theme, context.args, context.cwd));
			return text;
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
			const result = await writeWorkspaceFile(ctx.cwd, params as WriteParams, signal, { lsp: lspFileHooks });
			if (isFailedDetails(result)) {
				return {
					content: [{ type: "text", text: formatErrorModelResult("write", result) }],
					details: result,
				};
			}
			return {
				content: [{ type: "text", text: formatWriteModelResult(result) }],
				details: result,
			};
		},
		renderCall(args, theme, context) {
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
		renderResult(result, { expanded }, theme, context) {
			const details = result.details;
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatWriteResult(details, theme, context.args, context.cwd, expanded));
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
			const result = await editWorkspace(ctx.cwd, params as EditParams, { versionCache, lsp: lspFileHooks });
			const text = isEditSuccessDetails(result)
				? formatEditModelResult(result)
				: isFailedDetails(result)
					? formatErrorModelResult("edit", result)
					: JSON.stringify(scrubVersions(result));
			return {
				content: [{ type: "text", text }],
				details: result,
			};
		},
		renderCall(args, theme, context) {
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
			if (isPartial) return new Text(formatToolCard({ tool: "edit", status: "running", target: editTarget(context.args), summary: "applying" }, theme), 0, 0);

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
			buildEditCallComponent(callComponent, context.args, theme);

			const component = context.lastComponent instanceof Box ? context.lastComponent : new Box(1, 1);
			component.clear();
			component.setBgFn(editResultBg(details, theme));
			const output = formatEditResult(details, theme, context.args, context.expanded);
			if (output === undefined) return component;
			component.addChild(new Text(output, 0, 0));
			return component;
		},
	});

	pi.on("tool_result", (event) => {
		if (isFileToolName(event.toolName) && isFailedDetails(event.details)) return { isError: true };
		return undefined;
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

	// edit 的折叠态也展示实际改动，避免默认视图只看到“diff available”而看不到内容。
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
	if (isFailedEditDetails(details)) {
		return formatFailureCard("edit", editTarget(args), details, theme);
	}
	if (!isEditSuccessDetails(details)) return undefined;
	const header = formatToolCard({
		tool: "edit",
		status: "success",
		target: details.path,
		summary: joinParts([formatDiffStats(details.diff), `${details.replacements} replacements`, details.diff !== "" ? "diff available" : "no diff", formatLspSummary(details.lsp?.diagnostics)]),
	}, theme);
	const diff = details.diff === "" ? undefined : renderDiff(details.diff);
	if (!expanded) return [header, diff].filter((part): part is string => part !== undefined).join("\n\n");
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

	if (fileContent === null) {
		return formatToolCard({ tool: "write", status: "error", target, summary: "invalid content arg" }, theme);
	}
	const lineCount = fileContent === "" ? 0 : fileContent.split(/\r\n?|\n/).length;
	const header = formatToolCard({
		tool: "write",
		status: "running",
		target,
		summary: joinParts([`${lineCount} lines`, formatChars(fileContent.length), options.expanded ? "preview" : "preview hidden"]),
	}, theme);
	if (!options.expanded || fileContent.length === 0) return header;

	let text = header;
	if (fileContent.length > 0) {
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

function displayToolPath(rawPath: string | null, cwd: string): string {
	if (rawPath === null || rawPath.length === 0) return "?";
	const normalizedCwd = (cwd || ".").replace(/\\/g, "/");
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const display = normalizedPath.startsWith(`${normalizedCwd}/`) ? normalizedPath.slice(normalizedCwd.length + 1) : rawPath;
	return display;
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
	return isFailedDetails(value);
}

function isFailedDetails(value: unknown): value is FailedResult {
	if (!isPlainRecord(value) || value["status"] !== "failed" || !isPlainRecord(value["error"])) return false;
	const error = value["error"];
	return typeof error["code"] === "string" && typeof error["message"] === "string";
}

function isFindDetails(value: unknown): value is FindDetails {
	return isPlainRecord(value)
		&& typeof value["query"] === "string"
		&& typeof value["path"] === "string"
		&& (value["strategy"] === "exact" || value["strategy"] === "glob" || value["strategy"] === "fuzzy")
		&& typeof value["totalMatches"] === "number"
		&& typeof value["scannedEntries"] === "number"
		&& Array.isArray(value["matches"])
		&& Array.isArray(value["collapsedGroups"]);
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

/** 文件工具失败的模型可见结果；完整错误结构保留在 details。 */
function formatErrorModelResult(tool: string, result: FailedResult): string {
	const next = result.error.next !== undefined ? `\nnext: ${escapeXmlText(result.error.next)}` : "";
	return `<error tool="${escapeXmlAttribute(tool)}" code="${escapeXmlAttribute(result.error.code)}">
${escapeXmlText(result.error.message)}${next}
</error>`;
}

/** read 的模型可见成功结果：默认字段留在 details，只输出定位、正文和非默认状态。 */
function formatReadModelResult(result: ReadSuccess): string {
	const attrs = [
		`path="${escapeXmlAttribute(result.path)}"`,
		`lines="${result.start_line}-${result.end_line}/${result.total_lines}"`,
	];
	if (result.continuation !== undefined) attrs.push(`more="${result.continuation.start_line}"`);
	else if (result.truncated) attrs.push(`truncated="true"`);
	if (result.ignored) attrs.push(`ignored="${escapeXmlAttribute(result.ignore_source ?? "true")}"`);
	if (result.bom) attrs.push(`bom="true"`);
	if (result.newline !== "lf") attrs.push(`newline="${result.newline}"`);

	const lsp = formatReadLsp(result.lsp);
	let text = `<read ${attrs.join(" ")}>\n${result.content}`;
	if (!text.endsWith("\n")) text += "\n";
	if (lsp !== undefined) text += `${lsp}\n`;
	return `${text}</read>`;
}

/** edit 的模型可见成功结果只确认写入事实；diff/LSP 完整信息保留在 details 给 UI。 */
function formatEditModelResult(result: EditSuccess): string {
	const attrs = [
		`path="${escapeXmlAttribute(result.path)}"`,
		`replacements="${result.replacements}"`,
	];
	if (result.firstChangedLine !== undefined) attrs.push(`first_changed_line="${result.firstChangedLine}"`);
	return `<edit ${attrs.join(" ")}/>`;
}

function formatWriteModelResult(result: WriteSuccess): string {
	const diagnostics = result.lsp?.diagnostics;
	const status = diagnostics?.status ?? "clean";
	const attrs = [
		`path="${escapeXmlAttribute(result.path)}"`,
		`lsp="${escapeXmlAttribute(status)}"`,
	];
	if (diagnostics === undefined || isCleanDiagnostics(diagnostics)) return `<write ${attrs.join(" ")}/>`;

	const lines = [
		`<write ${attrs.join(" ")}>`,
		`errors=${diagnostics.file_errors} warnings=${diagnostics.file_warnings} new_errors=${diagnostics.new_errors} new_warnings=${diagnostics.new_warnings}`,
		...formatDiagnosticItems(diagnostics.items, 5),
		"</write>",
	];
	return lines.join("\n");
}

function isCleanDiagnostics(diagnostics: LspDiagnosticsSummary): boolean {
	return diagnostics.status === "clean"
		&& diagnostics.file_errors === 0
		&& diagnostics.file_warnings === 0
		&& diagnostics.new_errors === 0
		&& diagnostics.new_warnings === 0
		&& diagnostics.items.length === 0;
}

function formatDiagnosticItems(items: LspDiagnosticsSummary["items"], limit: number): string[] {
	const visible = items.slice(0, limit).map((item) => {
		const code = item.code !== undefined ? ` (${item.code})` : "";
		return `diag ${item.severity} ${item.line}:${item.column} ${escapeXmlText(item.message)}${escapeXmlText(code)}`;
	});
	const remaining = items.length - visible.length;
	if (remaining > 0) visible.push(`... ${remaining} more diagnostics`);
	return visible;
}

function formatReadLsp(lsp: ReadSuccess["lsp"]): string | undefined {
	if (lsp === undefined) return undefined;
	const attrs: string[] = [];
	if (lsp.enclosing_symbol !== undefined) attrs.push(`enclosing="${escapeXmlAttribute(formatSymbolRange(lsp.enclosing_symbol))}"`);
	if (lsp.outline !== undefined && lsp.outline.length > 0) attrs.push(`outline="${escapeXmlAttribute(lsp.outline.map(formatOutlineItem).join("; "))}"`);
	return attrs.length === 0 ? undefined : `<lsp ${attrs.join(" ")}/>`;
}

function formatOutlineItem(item: LspOutlineItem): string {
	const current = formatSymbolRange(item);
	if (item.children === undefined || item.children.length === 0) return current;
	return `${current} > ${item.children.map(formatOutlineItem).join(", ")}`;
}

function formatSymbolRange(item: LspOutlineItem | LspEnclosingSymbol): string {
	return `${item.kind} ${item.name} ${item.line}-${item.end_line}`;
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function formatFindCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	const query = stringArg(record["query"]);
	const rawPath = stringArg(record["path"]) ?? ".";
	return formatToolCard({
		tool: "find",
		status: "running",
		target: `${query === null ? "?" : `"${query}"`} in ${displayToolPath(rawPath, cwd)}`,
		summary: "locating files/directories",
	}, theme);
}

function formatFindResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	expanded: boolean,
	isPartial: boolean,
	theme: Pick<Theme, "fg" | "bold">,
	args: unknown,
	cwd: string,
): string {
	if (isPartial) return formatToolCard({ tool: "find", status: "running", target: findTarget(args, cwd), summary: "locating files/directories" }, theme);
	const failure = formatFailureCard("find", findTarget(args, cwd), result.details, theme);
	if (failure !== undefined) return failure;
	if (isFindDetails(result.details)) return formatFindDetails(result.details, expanded, theme);

	const output = textOutput(result).trim();
	if (output.length === 0) return "";
	const lines = output.split("\n");
	const maxLines = expanded ? lines.length : 20;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}
	return text;
}

function formatFindDetails(details: FindDetails, expanded: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	const files = details.matches.filter((match) => match.kind === "file").length;
	const directories = details.matches.filter((match) => match.kind === "directory").length;
	const summary = joinParts([
		`${details.totalMatches} ${details.totalMatches === 1 ? "match" : "matches"}`,
		`${files} ${files === 1 ? "file" : "files"}`,
		`${directories} ${directories === 1 ? "directory" : "directories"}`,
		details.strategy,
		details.truncated ? "truncated" : undefined,
	]);
	const header = formatToolCard({ tool: "find", status: "success", target: `"${details.query}" in ${details.path}`, summary }, theme);
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
	lines.push("", `Scanned ${details.scannedEntries} entries; skipped ${details.skippedCount}; ignored ${details.ignoredCount}.`);
	if (details.truncated) lines.push("Truncated.");
	return lines.map((line) => line === header ? line : theme.fg("toolOutput", line)).join("\n");
}

function formatLsCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	const rawPath = stringArg(record["path"]) ?? ".";
	return formatToolCard({ tool: "ls", status: "running", target: displayToolPath(rawPath, cwd), summary: "listing directory" }, theme);
}

function formatLsResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	expanded: boolean,
	isPartial: boolean,
	theme: Pick<Theme, "fg" | "bold">,
	cwd: string,
): string {
	const target = isLsSuccess(result.details) ? result.details.path : cwd;
	if (isPartial) return formatToolCard({ tool: "ls", status: "running", target, summary: "listing directory" }, theme);
	const failure = formatFailureCard("ls", target, result.details, theme);
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

function formatReadResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	expanded: boolean,
	isPartial: boolean,
	theme: Pick<Theme, "fg" | "bold">,
	args: unknown,
	cwd: string,
): string {
	const target = isReadSuccess(result.details) ? result.details.path : readTarget(args, cwd);
	if (isPartial) return formatToolCard({ tool: "read", status: "running", target, summary: "reading file" }, theme);
	const failure = formatFailureCard("read", target, result.details, theme);
	if (failure !== undefined) return failure;
	if (!isReadSuccess(result.details)) return fallbackTextResult(result, expanded, theme, 10);
	const details = result.details;
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
	const failure = formatFailureCard("write", target, details, theme);
	if (failure !== undefined) return failure;
	if (!isWriteSuccess(details)) return formatToolCard({ tool: "write", status: "neutral", target, summary: "waiting" }, theme);
	const header = formatToolCard({ tool: "write", status: "success", target: details.path, summary: joinParts([formatBytes(details.bytes), "written", formatLspSummary(details.lsp?.diagnostics)]) }, theme);
	if (!expanded) return header;
	const diagnostics = formatLspDiagnostics(details.lsp?.diagnostics, theme);
	return diagnostics === undefined ? header : `${header}\n\n${diagnostics}`;
}

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

function fallbackTextResult(
	result: { content: Array<{ type: string; text?: string }> },
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

function formatFailureCard(tool: string, target: string, details: unknown, theme: Pick<Theme, "fg" | "bold">): string | undefined {
	if (!isFailedDetails(details)) return undefined;
	return formatToolCard({ tool, status: "error", target, summary: `${details.error.code}: ${details.error.message}` }, theme);
}

function grepTarget(args: unknown): string {
	const record = isPlainRecord(args) ? args : {};
	const query = typeof record["query"] === "string" ? JSON.stringify(record["query"]) : "?";
	const scope = typeof record["path"] === "string" && record["path"].length > 0 ? record["path"] : ".";
	return `${query} in ${scope}`;
}

function findTarget(args: unknown, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	const query = stringArg(record["query"]);
	const rawPath = stringArg(record["path"]) ?? ".";
	return `${query === null ? "?" : `"${query}"`} in ${displayToolPath(rawPath, cwd)}`;
}

function readTarget(args: unknown, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	return displayToolPath(stringArg(record["path"]), cwd);
}

function writeTarget(args: unknown, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	return displayToolPath(stringArg(record["file_path"] ?? record["path"]), cwd);
}

function editTarget(args: unknown): string {
	return isPlainRecord(args) && typeof args["path"] === "string" && args["path"].length > 0 ? args["path"] : "file";
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
	if (diagnostics === undefined) return undefined;
	if (diagnostics.status === "timeout") return "LSP timeout";
	if (diagnostics.status === "unavailable") return "LSP unavailable";
	return `LSP ${diagnostics.file_errors} errors`;
}

function formatLspDiagnostics(diagnostics: LspDiagnosticsSummary | undefined, theme: Pick<Theme, "fg">): string | undefined {
	if (diagnostics === undefined || diagnostics.items.length === 0) return undefined;
	return diagnostics.items
		.map((item) => theme.fg("toolOutput", `${item.severity} ${item.line}:${item.column} ${item.message}${item.code !== undefined ? ` (${item.code})` : ""}`))
		.join("\n");
}

function isLsSuccess(value: unknown): value is LsSuccess {
	return isPlainRecord(value) && typeof value["path"] === "string" && Array.isArray(value["entries"]) && typeof value["truncated"] === "boolean";
}

function isReadSuccess(value: unknown): value is ReadSuccess {
	return isPlainRecord(value)
		&& typeof value["path"] === "string"
		&& typeof value["content"] === "string"
		&& typeof value["start_line"] === "number"
		&& typeof value["end_line"] === "number"
		&& typeof value["total_lines"] === "number";
}

function isWriteSuccess(value: unknown): value is WriteSuccess {
	return isPlainRecord(value) && value["status"] === "written" && typeof value["path"] === "string" && typeof value["bytes"] === "number";
}

function isFileToolName(value: string): boolean {
	return value === "ls" || value === "find" || value === "grep" || value === "read" || value === "write" || value === "edit";
}

type NativeLsDetails = LsSuccess & {
	/** Pi 内置 ls renderer 识别的条目上限标记。 */
	entryLimitReached?: number;
};

function withNativeLsDetails(result: LsSuccess): NativeLsDetails {
	if (!result.truncated) return result;
	return {
		...result,
		entryLimitReached: result.returned_entries ?? result.entries.length,
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
