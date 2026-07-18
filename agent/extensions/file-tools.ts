import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ReadVersionCache } from "../../src/file-tools/core/read-cache.js";
import {
	formatEditModelResult,
	formatErrorModelResult,
	formatReadImageModelContent,
	formatReadModelResult,
	formatWriteModelResult,
	scrubVersions,
} from "../../src/file-tools/pi/model-output.js";
import { versionCacheFor, withNativeLsDetails } from "../../src/file-tools/pi/native.js";
import {
	isEditSuccessDetails,
	isFailedDetails,
	isFileToolName,
	isReadImageSuccess,
	isReadSuccess,
} from "../../src/file-tools/pi/guards.js";
import {
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
} from "../../src/file-tools/pi/renderers.js";
import type { EditParams, FindParams, GrepParams, LsParams, ReadParams, WriteParams } from "../../src/file-tools/types.js";
import { createRepoMapFileToolQuery, type RepoMapMutationResult } from "../../src/repo-map/file-tool-query.js";
import { repairableTool } from "../../src/tool-repair/index.js";

const lsParameters = Type.Object({ path: Type.Optional(Type.String({ minLength: 1, description: "Directory path; defaults to workspace." })) }, { additionalProperties: false });
const findParameters = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			description: "File or directory name, path fragment, or glob. Searches recursively under path; use ** only inside recursive glob patterns.",
		}),
		path: Type.Optional(Type.String({ minLength: 1, description: "Search root; defaults to workspace." })),
	},
	{ additionalProperties: false },
);
const grepParameters = Type.Object(
	{
		query: Type.String({ minLength: 1, description: "Text, symbol, or code intent. Set match=regex for regular expressions." }),
		path: Type.Optional(Type.String({ minLength: 1, description: "File or directory scope; defaults to workspace." })),
		match: Type.Optional(StringEnum(["auto", "literal", "regex"] as const, { description: "Query interpretation; defaults to auto." })),
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
				old: Type.String({ minLength: 1, description: "Exact text that appears once in the original file. Must be UNIQUE in the original file." }),
				new: Type.String({ description: "Replacement text." }),
			},
			{ additionalProperties: false },
		),
		{ minItems: 1, description: "Non-overlapping replacements matched against the original file." },
	),
}, { additionalProperties: false });

export interface FileToolsModuleImports {
	ls(): Promise<typeof import("../../src/file-tools/tools/ls.js")>;
	find(): Promise<typeof import("../../src/file-tools/tools/find.js")>;
	grep(): Promise<typeof import("../../src/file-tools/tools/grep.js")>;
	read(): Promise<typeof import("../../src/file-tools/tools/read.js")>;
	write(): Promise<typeof import("../../src/file-tools/tools/write.js")>;
	edit(): Promise<typeof import("../../src/file-tools/tools/edit.js")>;
	lsp(): Promise<typeof import("../../src/lsp/index.js")>;
}

const defaultModuleImports: FileToolsModuleImports = {
	ls: () => import("../../src/file-tools/tools/ls.js"),
	find: () => import("../../src/file-tools/tools/find.js"),
	grep: () => import("../../src/file-tools/tools/grep.js"),
	read: () => import("../../src/file-tools/tools/read.js"),
	write: () => import("../../src/file-tools/tools/write.js"),
	edit: () => import("../../src/file-tools/tools/edit.js"),
	lsp: () => import("../../src/lsp/index.js"),
};

export function createFileToolsExtension(imports: FileToolsModuleImports = defaultModuleImports): (pi: ExtensionAPI) => void {
	const loaders: FileToolsModuleImports = {
		ls: createRetryableLoader(imports.ls),
		find: createRetryableLoader(imports.find),
		grep: createRetryableLoader(imports.grep),
		read: createRetryableLoader(imports.read),
		write: createRetryableLoader(imports.write),
		edit: createRetryableLoader(imports.edit),
		lsp: createRetryableLoader(imports.lsp),
	};
	return (pi) => registerFileTools(pi, loaders);
}

/** 注册覆盖版 ls/find/grep/read/write/edit；扩展层只适配 Pi，工具实现和渲染细节在 src/file-tools。 */
function registerFileTools(pi: ExtensionAPI, loaders: FileToolsModuleImports): void {
	const versionCaches = new Map<string, ReadVersionCache>();
	let commonPreloadTimer: ReturnType<typeof setTimeout> | undefined;
	let searchPreloadTimer: ReturnType<typeof setTimeout> | undefined;

	pi.registerTool(repairableTool({
		name: "ls",
		label: "ls",
		description: "List direct entries of one directory; no recursion or file contents.",
		promptSnippet: "list one directory",
		parameters: lsParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { formatCompactLsResult, listWorkspaceDirectory } = await loaders.ls();
			const result = await listWorkspaceDirectory(ctx.cwd, params as LsParams);
			if (isFailedDetails(result)) {
				return { content: [{ type: "text", text: formatErrorModelResult("ls", result) }], details: result };
			}
			return { content: [{ type: "text", text: formatCompactLsResult(result) }], details: withNativeLsDetails(result) };
		},
		renderCall: renderLsCall,
		renderResult: renderLsResult,
	}, { singleStringField: "path", pathFields: ["path"] }));

	pi.registerTool(repairableTool({
		name: "find",
		label: "find",
		description: "Find files or directories by name, path fragment, or glob; does not search contents.",
		promptSnippet: "locate files or directories by path",
		parameters: findParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { findWorkspaceFiles } = await loaders.find();
			const result = await findWorkspaceFiles(ctx.cwd, params as FindParams, signal, { repoMap: repoMapQueryFor(ctx, pi) });
			if (isFailedDetails(result)) {
				return { content: [{ type: "text", text: formatErrorModelResult("find", result) }], details: result };
			}
			return { content: [{ type: "text", text: result.content }], details: result.details };
		},
		renderCall: renderFindCall,
		renderResult: renderFindResult,
	}, { singleStringField: "query", pathFields: ["path"] }));

	pi.registerTool(repairableTool({
		name: "grep",
		label: "grep",
		description: "Search code content by text, symbol, regex, or intent; return ranked syntax-aware regions.",
		promptSnippet: "locate relevant code by content or symbol",
		parameters: grepParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const [{ formatCompactGrepResult, grepWorkspaceFiles }, { lspFileHooks }] = await Promise.all([
				loaders.grep(),
				loaders.lsp(),
			]);
			const result = await grepWorkspaceFiles(ctx.cwd, params as GrepParams, signal, { lsp: lspFileHooks, repoMap: repoMapQueryFor(ctx, pi) });
			if (isFailedDetails(result)) {
				return { content: [{ type: "text", text: formatErrorModelResult("grep", result) }], details: result };
			}
			return { content: [{ type: "text", text: formatCompactGrepResult(result) }], details: result };
		},
		renderCall: renderGrepCall,
		renderResult: renderGrepResult,
	}, { singleStringField: "query", pathFields: ["path"] }));

	pi.registerTool(repairableTool({
		name: "read",
		label: "read",
		description: "Read one UTF-8 text file or image file. Line ranges apply only to text. Records file version for edit.",
		promptSnippet: "read text or image files",
		parameters: readParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const [{ readWorkspaceFile }, { lspFileHooks }] = await Promise.all([
				loaders.read(),
				loaders.lsp(),
			]);
			const versionCache = versionCacheFor(ctx, versionCaches);
			const result = await readWorkspaceFile(ctx.cwd, params as ReadParams, {
				versionCache,
				lsp: lspFileHooks,
				repoMap: repoMapQueryFor(ctx, pi),
			});
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
	}, {
		singleStringField: "path",
		pathFields: ["path"],
		aliases: {
			startLine: "start_line",
			endLine: "end_line",
		},
	}));

	pi.registerTool(repairableTool({
		name: "write",
		label: "write",
		description: "Create or replace one file in a whole.",
		promptSnippet: "create or replace one file in a whole",
		promptGuidelines: ["Use write to create or replace a whole file."],
		parameters: writeParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const [{ writeWorkspaceFile }, { lspFileHooks }] = await Promise.all([
				loaders.write(),
				loaders.lsp(),
			]);
			const result = await writeWorkspaceFile(ctx.cwd, params as WriteParams, signal, { lsp: lspFileHooks });
			if (isFailedDetails(result)) {
				return { content: [{ type: "text", text: formatErrorModelResult("write", result) }], details: result };
			}
			await syncRepoMapMutation(repoMapQueryFor(ctx, pi), result, ctx.cwd, signal);
			return { content: [{ type: "text", text: formatWriteModelResult(result) }], details: result };
		},
		renderCall: renderWriteCall,
		renderResult: renderWriteResult,
	}, {
		pathFields: ["path"],
		aliases: {
			text: "content",
			contents: "content",
		},
	}));

	pi.registerTool(repairableTool({
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const [{ editWorkspace }, { lspFileHooks }] = await Promise.all([
				loaders.edit(),
				loaders.lsp(),
			]);
			const versionCache = versionCacheFor(ctx, versionCaches);
			const result = await editWorkspace(ctx.cwd, params as EditParams, { versionCache, lsp: lspFileHooks });
			if (isEditSuccessDetails(result)) await syncRepoMapMutation(repoMapQueryFor(ctx, pi), result, ctx.cwd, signal);
			const text = isEditSuccessDetails(result)
				? formatEditModelResult(result)
				: isFailedDetails(result)
					? formatErrorModelResult("edit", result)
					: JSON.stringify(scrubVersions(result));
			return { content: [{ type: "text", text }], details: result };
		},
		renderCall: renderEditCall,
		renderResult: renderEditResult,
	}, {
		pathFields: ["path"],
		aliases: {
			oldText: "old",
			newText: "new",
		},
		nestedAliases: {
			"edits.*.oldText": "old",
			"edits.*.newText": "new",
		},
		objectArrayFromFields: [{ arrayField: "edits", fields: ["old", "new"] }],
	}));

	pi.on("session_start", () => {
		commonPreloadTimer ??= schedulePreload([loaders.ls, loaders.read, loaders.write, loaders.edit, loaders.lsp]);
	});
	pi.on("before_agent_start", () => {
		searchPreloadTimer ??= schedulePreload([loaders.find, loaders.grep]);
	});
	pi.on("tool_result", (event) => {
		if (isFileToolName(event.toolName) && isFailedDetails(event.details)) return { isError: true };
		return undefined;
	});
	pi.on("session_shutdown", () => {
		if (commonPreloadTimer !== undefined) clearTimeout(commonPreloadTimer);
		if (searchPreloadTimer !== undefined) clearTimeout(searchPreloadTimer);
		versionCaches.clear();
	});
}

function repoMapQueryFor(ctx: ExtensionContext, pi: Pick<ExtensionAPI, "appendEntry">) {
	return createRepoMapFileToolQuery(
		() => typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [],
		{ appendActivation(entry) { pi.appendEntry("o-pi:repo-map", entry); } },
	);
}

async function syncRepoMapMutation(
	query: ReturnType<typeof repoMapQueryFor>,
	result: { path: string; firstChangedLine?: number; repo_map?: RepoMapMutationResult },
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	try {
		const update = await query.syncMutation({
			requestedPath: path.resolve(cwd, result.path),
			...(result.firstChangedLine !== undefined ? { changedLine: result.firstChangedLine } : {}),
			...(signal !== undefined ? { signal } : {}),
		});
		if (update !== undefined) result.repo_map = update;
	} catch {
		// Repo Map is a non-blocking enhancement; the file mutation already succeeded.
	}
}

function createRetryableLoader<T>(load: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | undefined;
	return () => {
		if (pending !== undefined) return pending;
		const created = load();
		pending = created;
		void created.catch(() => {
			if (pending === created) pending = undefined;
		});
		return created;
	};
}

function schedulePreload(loaders: Array<() => Promise<unknown>>): ReturnType<typeof setTimeout> {
	return setTimeout(() => {
		for (const load of loaders) void load().catch(() => undefined);
	}, 0);
}

const fileTools = createFileToolsExtension();

export default fileTools;
