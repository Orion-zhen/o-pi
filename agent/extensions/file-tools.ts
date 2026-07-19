import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ReadVersionCache } from "../../src/file-tools/core/read-cache.js";
import { isFailedDetails, isFileToolName } from "../../src/file-tools/pi/guards.js";
import { createLazyLspFileHooks } from "../../src/file-tools/pi/lazy-lsp.js";
import { appendRepoMapEntry, createLazyRepoMap, type LazyRepoMap } from "../../src/file-tools/pi/lazy-repo-map.js";
import { versionCacheFor } from "../../src/file-tools/pi/native.js";
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
import { repairableTool } from "../../src/tool-repair/index.js";

const lsParameters = Type.Object({ path: Type.Optional(Type.String({ minLength: 1, description: "Directory; default workspace." })) }, { additionalProperties: false });
const findParameters = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			description: "Name, path fragment, or concept.",
		}),
		path: Type.Optional(Type.String({ minLength: 1, description: "Search root; default workspace." })),
		glob: Type.Optional(Type.String({ minLength: 1, description: "Strict relative path filter for main results." })),
	},
	{ additionalProperties: false },
);
const grepParameters = Type.Object(
	{
		query: Type.String({ minLength: 1, description: "Text, symbol, concept, definition, or relationship." }),
		path: Type.Optional(Type.String({ minLength: 1, description: "File or directory scope; default workspace." })),
		match: Type.Optional(StringEnum(["auto", "literal", "regex"] as const, { description: "Matching strategy. literal: case-sensitive text; regex: regular expression; default auto." })),
		glob: Type.Optional(Type.String({ minLength: 1, description: "Strict relative file-path filter." })),
	},
	{ additionalProperties: false },
);
const readParameters = Type.Object(
	{
		path: Type.String({ description: "Text or image path." }),
		start_line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based inclusive start line for text." })),
		end_line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based inclusive end line for text." })),
	},
	{ additionalProperties: false },
);
const writeParameters = Type.Object(
	{
		path: Type.String({ description: "Destination path." }),
		content: Type.String(),
	},
	{ additionalProperties: false },
);
const editParameters = Type.Object({
	path: Type.String({ description: "Previously read file." }),
	edits: Type.Array(
		Type.Object(
			{
				old: Type.String({ minLength: 1, description: "Exact text occurring once in original content. Must be UNIQUE." }),
				new: Type.String(),
			},
			{ additionalProperties: false },
		),
		{ minItems: 1, description: "Non-overlapping replacements against original content." },
	),
}, { additionalProperties: false });

export interface FileToolsModuleImports {
	ls(): Promise<typeof import("../../src/file-tools/pi/adapters/ls.js")>;
	find(): Promise<typeof import("../../src/file-tools/pi/adapters/find.js")>;
	grep(): Promise<typeof import("../../src/file-tools/pi/adapters/grep.js")>;
	read(): Promise<typeof import("../../src/file-tools/pi/adapters/read.js")>;
	write(): Promise<typeof import("../../src/file-tools/pi/adapters/write.js")>;
	edit(): Promise<typeof import("../../src/file-tools/pi/adapters/edit.js")>;
	lsp(): Promise<typeof import("../../src/lsp/index.js")>;
	repoMap(): Promise<typeof import("../../src/file-tools/pi/repo-map-runtime.js")>;
}

const defaultModuleImports: FileToolsModuleImports = {
	ls: () => import("../../src/file-tools/pi/adapters/ls.js"),
	find: () => import("../../src/file-tools/pi/adapters/find.js"),
	grep: () => import("../../src/file-tools/pi/adapters/grep.js"),
	read: () => import("../../src/file-tools/pi/adapters/read.js"),
	write: () => import("../../src/file-tools/pi/adapters/write.js"),
	edit: () => import("../../src/file-tools/pi/adapters/edit.js"),
	lsp: () => import("../../src/lsp/index.js"),
	repoMap: () => import("../../src/file-tools/pi/repo-map-runtime.js"),
};

export function createFileToolsExtension(imports: FileToolsModuleImports = defaultModuleImports): (pi: ExtensionAPI) => void {
	const cacheDisposers = new Set<() => void>();
	const loaders: FileToolsModuleImports = {
		ls: createRetryableLoader(async () => registerCacheDisposer(await imports.ls(), cacheDisposers)),
		find: createRetryableLoader(async () => registerCacheDisposer(await imports.find(), cacheDisposers)),
		grep: createRetryableLoader(async () => registerCacheDisposer(await imports.grep(), cacheDisposers)),
		read: createRetryableLoader(async () => registerCacheDisposer(await imports.read(), cacheDisposers)),
		write: createRetryableLoader(async () => registerCacheDisposer(await imports.write(), cacheDisposers)),
		edit: createRetryableLoader(async () => registerCacheDisposer(await imports.edit(), cacheDisposers)),
		lsp: createRetryableLoader(imports.lsp),
		repoMap: createRetryableLoader(imports.repoMap),
	};
	return (pi) => registerFileTools(pi, loaders, cacheDisposers);
}

/** 注册覆盖版 ls/find/grep/read/write/edit；扩展层只适配 Pi，工具实现和渲染细节在 src/file-tools。 */
function registerFileTools(pi: ExtensionAPI, loaders: FileToolsModuleImports, cacheDisposers: Set<() => void>): void {
	const versionCaches = new Map<string, ReadVersionCache>();
	const repoMaps = new Map<string, LazyRepoMap>();
	const lsp = createLazyLspFileHooks(loaders.lsp);
	const repoMapFor = (ctx: ExtensionContext): LazyRepoMap => {
		const sessionId = ctx.sessionManager.getSessionId();
		const existing = repoMaps.get(sessionId);
		if (existing !== undefined) return existing;
		const created = createLazyRepoMap({
			getBranch: () => typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [],
			appendEntry: (entry) => appendRepoMapEntry(pi, entry),
			load: loaders.repoMap,
		});
		repoMaps.set(sessionId, created);
		return created;
	};

	pi.registerTool(repairableTool({
		name: "ls",
		label: "ls",
		description: "List direct entries of one directory.",
		promptSnippet: "list one directory",
		parameters: lsParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return (await loaders.ls()).executeLs(params as LsParams, ctx.cwd);
		},
		renderCall: renderLsCall,
		renderResult: renderLsResult,
	}, { singleStringField: "path", pathFields: ["path"] }));

	pi.registerTool(repairableTool({
		name: "find",
		label: "find",
		description: "Locate files or directories by name, path, or concept. Does not search contents.",
		promptSnippet: "locate files or directories",
		parameters: findParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return (await loaders.find()).executeFind(params as FindParams, {
				cwd: ctx.cwd,
				...(signal !== undefined ? { signal } : {}),
				repoMap: repoMapFor(ctx),
			});
		},
		renderCall: renderFindCall,
		renderResult: renderFindResult,
	}, { singleStringField: "query", pathFields: ["path"] }));

	pi.registerTool(repairableTool({
		name: "grep",
		label: "grep",
		description: "Locate code regions by text, symbol, concept, definition, or relationship.",
		promptSnippet: "locate relevant code",
		parameters: grepParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return (await loaders.grep()).executeGrep(params as GrepParams, {
				cwd: ctx.cwd,
				...(signal !== undefined ? { signal } : {}),
				lsp,
				repoMap: repoMapFor(ctx),
			});
		},
		renderCall: renderGrepCall,
		renderResult: renderGrepResult,
	}, { singleStringField: "query", pathFields: ["path"] }));

	pi.registerTool(repairableTool({
		name: "read",
		label: "read",
		description: "Read one text or image file.",
		promptSnippet: "read one file",
		parameters: readParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return (await loaders.read()).executeRead(params as ReadParams, {
				cwd: ctx.cwd,
				model: ctx.model,
				versionCache: versionCacheFor(ctx, versionCaches),
				lsp,
				repoMap: repoMapFor(ctx),
			});
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
		description: "Create or overwrite one whole file.",
		promptSnippet: "write one whole file",
		parameters: writeParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return (await loaders.write()).executeWrite(params as WriteParams, {
				cwd: ctx.cwd,
				...(signal !== undefined ? { signal } : {}),
				lsp,
				repoMap: repoMapFor(ctx),
			});
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
		description: "Edit one previously read file with exact replacements.",
		promptSnippet: "edit one read file",
		parameters: editParameters,
		renderShell: "self",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return (await loaders.edit()).executeEdit(params as EditParams, {
				cwd: ctx.cwd,
				...(signal !== undefined ? { signal } : {}),
				versionCache: versionCacheFor(ctx, versionCaches),
				lsp,
				repoMap: repoMapFor(ctx),
			});
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

	pi.on("tool_result", (event) => {
		if (isFileToolName(event.toolName) && isFailedDetails(event.details)) return { isError: true };
		return undefined;
	});
	pi.on("session_shutdown", async () => {
		versionCaches.clear();
		repoMaps.clear();
		await lsp.shutdown();
		for (const dispose of cacheDisposers) dispose();
	});
}

function registerCacheDisposer<T extends { disposeFileToolsCaches(): void }>(module: T, disposers: Set<() => void>): T {
	disposers.add(module.disposeFileToolsCaches);
	return module;
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

const fileTools = createFileToolsExtension();

export default fileTools;
