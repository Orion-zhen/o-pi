import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { editWorkspace } from "../../src/file-tools/tools/edit.js";
import { findWorkspaceFiles } from "../../src/file-tools/tools/find.js";
import { formatCompactGrepResult, grepWorkspaceFiles } from "../../src/file-tools/tools/grep.js";
import {
	formatEditModelResult,
	formatErrorModelResult,
	formatReadImageModelContent,
	formatReadModelResult,
	formatWriteModelResult,
	isEditSuccessDetails,
	isFailedDetails,
	isFileToolName,
	isReadImageSuccess,
	isReadSuccess,
	renderEditCall,
	renderEditResult,
	renderFindCall,
	renderFindResult,
	renderGrepCall,
	renderGrepResult,
	renderLsCall,
	renderLsResult,
	renderReadCall,
	renderReadResult,
	renderWriteCall,
	renderWriteResult,
	scrubVersions,
	versionCacheFor,
	withNativeLsDetails,
} from "../../src/file-tools/index.js";
import { formatCompactLsResult, listWorkspaceDirectory } from "../../src/file-tools/tools/ls.js";
import { ReadVersionCache } from "../../src/file-tools/core/read-cache.js";
import { readWorkspaceFile } from "../../src/file-tools/tools/read.js";
import type { EditParams, FindParams, GrepParams, LsParams, ReadParams, WriteParams } from "../../src/file-tools/types.js";
import { writeWorkspaceFile } from "../../src/file-tools/tools/write.js";
import { lspFileHooks } from "../../src/lsp/index.js";

const lsParameters = Type.Object({ path: Type.String({ description: "Directory path." }) }, { additionalProperties: false });
const findParameters = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			description: "File or directory name, path fragment, or glob; use ** for recursive find.",
		}),
		path: Type.Optional(Type.String({ minLength: 1, description: "Search root; defaults to workspace." })),
	},
	{ additionalProperties: false },
);
const grepParameters = Type.Object(
	{
		query: Type.String({ minLength: 1, description: "Text, symbol, regex, or code intent to find." }),
		path: Type.Optional(Type.String({ minLength: 1, description: "File or directory scope; defaults to workspace." })),
		match: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("literal"), Type.Literal("regex")], { description: "Query interpretation; defaults to auto." })),
		glob: Type.Optional(Type.String({ minLength: 1, description: "Relative file glob within path." })),
	},
	{ additionalProperties: false },
);
const readParameters = Type.Object(
	{
		path: Type.String({ description: "Text or image file path." }),
		start_line: Type.Optional(Type.Integer({ minimum: 1, description: "Text files only: 1-based inclusive start line." })),
		end_line: Type.Optional(Type.Integer({ minimum: 1, description: "Text files only: 1-based inclusive end line." })),
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
				old: Type.String({ minLength: 1, description: "Exact text that appears once in the original file." }),
				new: Type.String({ description: "Replacement text." }),
			},
			{ additionalProperties: false },
		),
		{ minItems: 1, description: "Non-overlapping replacements matched against the original file." },
	),
}, { additionalProperties: false });

/** 注册覆盖版 ls/find/read/write/edit；扩展层只适配 Pi，工具实现和渲染细节在 src/file-tools。 */
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
				return { content: [{ type: "text", text: formatErrorModelResult("ls", result) }], details: result };
			}
			return { content: [{ type: "text", text: formatCompactLsResult(result) }], details: withNativeLsDetails(result) };
		},
		renderCall: renderLsCall,
		renderResult: renderLsResult,
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
				return { content: [{ type: "text", text: formatErrorModelResult("find", result) }], details: result };
			}
			return { content: [{ type: "text", text: result.content }], details: result.details };
		},
		renderCall: renderFindCall,
		renderResult: renderFindResult,
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
				return { content: [{ type: "text", text: formatErrorModelResult("grep", result) }], details: result };
			}
			return { content: [{ type: "text", text: formatCompactGrepResult(result) }], details: result };
		},
		renderCall: renderGrepCall,
		renderResult: renderGrepResult,
	});

	pi.registerTool({
		name: "read",
		label: "read",
		description: "Read one UTF-8 text file or image file. Line ranges apply only to text. Records file version for edit.",
		promptSnippet: "read text or image files",
		parameters: readParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const versionCache = versionCacheFor(ctx, versionCaches);
			const result = await readWorkspaceFile(ctx.cwd, params as ReadParams, { versionCache, lsp: lspFileHooks });
			const content = isReadImageSuccess(result)
				? formatReadImageModelContent(result, ctx.model)
				: [{
						type: "text" as const,
						text: isReadSuccess(result)
							? formatReadModelResult(result)
							: isFailedDetails(result)
								? formatErrorModelResult("read", result)
								: JSON.stringify(scrubVersions(result)),
					}];
			return { content, details: result };
		},
		renderCall: renderReadCall,
		renderResult: renderReadResult,
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
				return { content: [{ type: "text", text: formatErrorModelResult("write", result) }], details: result };
			}
			return { content: [{ type: "text", text: formatWriteModelResult(result) }], details: result };
		},
		renderCall: renderWriteCall,
		renderResult: renderWriteResult,
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
		renderShell: "self",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const versionCache = versionCacheFor(ctx, versionCaches);
			const result = await editWorkspace(ctx.cwd, params as EditParams, { versionCache, lsp: lspFileHooks });
			const text = isEditSuccessDetails(result)
				? formatEditModelResult(result)
				: isFailedDetails(result)
					? formatErrorModelResult("edit", result)
					: JSON.stringify(scrubVersions(result));
			return { content: [{ type: "text", text }], details: result };
		},
		renderCall: renderEditCall,
		renderResult: renderEditResult,
	});

	pi.on("tool_result", (event) => {
		if (isFileToolName(event.toolName) && isFailedDetails(event.details)) return { isError: true };
		return undefined;
	});
}
