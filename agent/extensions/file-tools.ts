import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { isFailedDetails, isFileToolName } from "../../src/file-tools/pi/guards.js";
import { createLazyLspFileOperations } from "../../src/file-tools/pi/lazy-lsp.js";
import { appendRepoMapEntry, createLazyRepoMap, type LazyRepoMap } from "../../src/file-tools/pi/lazy-repo-map.js";
import type { LsParams } from "../../src/file-tools/ls/types.js";
import type { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import type { ReadParams } from "../../src/file-tools/read/types.js";
import type { EditParams, EditSuccess } from "../../src/file-tools/edit/types.js";
import type { FindParams } from "../../src/file-tools/find/types.js";
import type { GrepParams } from "../../src/file-tools/grep/types.js";
import type { WriteParams, WriteSuccess } from "../../src/file-tools/write/types.js";
import { editTelemetry } from "../../src/file-tools/telemetry/edit.js";
import { findTelemetry } from "../../src/file-tools/telemetry/find.js";
import { grepTelemetry } from "../../src/file-tools/telemetry/grep.js";
import { lsTelemetry } from "../../src/file-tools/telemetry/ls.js";
import { readTelemetry } from "../../src/file-tools/telemetry/read.js";
import { writeTelemetry } from "../../src/file-tools/telemetry/write.js";
import type { ToolOutcome } from "../../src/file-tools/shared/result.js";
import type { MutationProgressDetails } from "../../src/file-tools/pi/progress.js";
import { registerObservedTool } from "../../src/telemetry/tool.js";
import { collectSkillCandidates } from "../../src/skill-context/loader.js";
import { buildSkillReadIndex } from "../../src/skill-context/resources.js";

const lsParameters = Type.Object({ path: Type.Optional(Type.String({ minLength: 1, description: "Directory; default workspace." })) }, { additionalProperties: false });
const findParameters = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			description: "Name, path fragment, concept, or glob.",
		}),
		path: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Search roots; OR/union scope; default workspace." })),
	},
	{ additionalProperties: false },
);
const grepParameters = Type.Object(
	{
		query: Type.String({ minLength: 1, description: "Text, symbol, concept, definition, or relationship." }),
		path: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "File or directory scopes; OR/union scope; default workspace." })),
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
	path: Type.String({ description: "Previously read or written file." }),
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
	host(): Promise<typeof import("../../src/file-tools/runtime/host.js")>;
	find(): Promise<typeof import("../../src/file-tools/pi/adapters/find.js")>;
	grep(): Promise<typeof import("../../src/file-tools/pi/adapters/grep.js")>;
	read(): Promise<typeof import("../../src/file-tools/pi/adapters/read.js")>;
	write(): Promise<typeof import("../../src/file-tools/pi/adapters/write.js")>;
	edit(): Promise<typeof import("../../src/file-tools/pi/adapters/edit.js")>;
	renderers?: () => Promise<typeof import("../../src/file-tools/pi/renderers.js")>;
	lsp(): Promise<typeof import("../../src/lsp/index.js")>;
	repoMap(): Promise<typeof import("../../src/file-tools/pi/repo-map-runtime.js")>;
}

type FindAdapter = ReturnType<(typeof import("../../src/file-tools/pi/adapters/find.js"))["createFindAdapter"]>;
type GrepAdapter = ReturnType<(typeof import("../../src/file-tools/pi/adapters/grep.js"))["createGrepAdapter"]>;
type FileToolsLoaders = Omit<FileToolsModuleImports, "find" | "grep" | "renderers"> & {
	find(): Promise<FindAdapter>;
	grep(): Promise<GrepAdapter>;
};

const defaultModuleImports: FileToolsModuleImports = {
	ls: () => import("../../src/file-tools/pi/adapters/ls.js"),
	host: () => import("../../src/file-tools/runtime/host.js"),
	find: () => import("../../src/file-tools/pi/adapters/find.js"),
	grep: () => import("../../src/file-tools/pi/adapters/grep.js"),
	read: () => import("../../src/file-tools/pi/adapters/read.js"),
	write: () => import("../../src/file-tools/pi/adapters/write.js"),
	edit: () => import("../../src/file-tools/pi/adapters/edit.js"),
	lsp: () => import("../../src/lsp/index.js"),
	repoMap: () => import("../../src/file-tools/pi/repo-map-runtime.js"),
};

export function createFileToolsExtension(imports: FileToolsModuleImports = defaultModuleImports): (pi: ExtensionAPI) => void {
	const loadedToolInstances = new Set<{ dispose(): void }>();
	const loaders: FileToolsLoaders = {
		ls: createRetryableLoader(imports.ls),
		host: createRetryableLoader(imports.host),
		find: createRetryableLoader(async () => {
			const adapter = (await imports.find()).createFindAdapter();
			loadedToolInstances.add(adapter);
			return adapter;
		}),
		grep: createRetryableLoader(async () => {
			const adapter = (await imports.grep()).createGrepAdapter();
			loadedToolInstances.add(adapter);
			return adapter;
		}),
		read: createRetryableLoader(imports.read),
		write: createRetryableLoader(imports.write),
		edit: createRetryableLoader(imports.edit),
		lsp: createRetryableLoader(imports.lsp),
		repoMap: createRetryableLoader(imports.repoMap),
	};
	const loadRenderers = createRetryableLoader(imports.renderers ?? (() => import("../../src/file-tools/pi/renderers.js")));
	return (pi) => registerFileTools(pi, loaders, loadedToolInstances, loaders.host, loadRenderers);
}

/** 注册覆盖版 ls/find/grep/read/write/edit；扩展层只适配 Pi，工具实现和渲染细节在 src/file-tools。 */
function registerFileTools(
	pi: ExtensionAPI,
	loaders: FileToolsLoaders,
	loadedToolInstances: ReadonlySet<{ dispose(): void }>,
	loadHost: () => Promise<typeof import("../../src/file-tools/runtime/host.js")>,
	loadRenderers: () => Promise<typeof import("../../src/file-tools/pi/renderers.js")>,
): void {
	const repoMaps = new Map<string, LazyRepoMap>();
	let host: FileToolsHost | undefined;
	let shuttingDown = false;
	const hostForInvocation = async (): Promise<FileToolsHost> => {
		const { FileToolsHost: Host } = await loadHost();
		if (host === undefined) host = new Host();
		if (shuttingDown) host.stop();
		return host;
	};
	const lsp = createLazyLspFileOperations(loaders.lsp);
	const skillReadIndex = createRetryableLoader(async () => buildSkillReadIndex(
		collectSkillCandidates(undefined, typeof pi.getCommands === "function" ? pi.getCommands() : []),
	));
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

	const lsTool = registerObservedTool(pi, {
		tool: {
		name: "ls",
		label: "ls",
		description: "List direct entries of one directory.",
		promptSnippet: "list one directory",
		parameters: lsParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const [module, invocationHost] = await Promise.all([loaders.ls(), hostForInvocation()]);
			return module.executeLs(params as LsParams, {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				...(signal === undefined ? {} : { signal }),
				host: invocationHost,
			});
		},
		},
		repair: { singleStringField: "path", pathFields: ["path"] },
		telemetry: lsTelemetry,
	});

	const findTool = registerObservedTool(pi, {
		tool: {
		name: "find",
		label: "find",
		description: "Locate files or directories by name, path, or concept. Does not search contents.",
		promptSnippet: "locate files or directories",
		parameters: findParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const [adapter, invocationHost] = await Promise.all([loaders.find(), hostForInvocation()]);
			return adapter.execute(params as FindParams, {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				...(signal !== undefined ? { signal } : {}),
				host: invocationHost,
				repoMap: repoMapFor(ctx),
			});
		},
		},
		repair: { singleStringField: "query", pathFields: ["path"], pathListFields: ["path"] },
		telemetry: findTelemetry,
	});

	const grepTool = registerObservedTool(pi, {
		tool: {
		name: "grep",
		label: "grep",
		description: "Locate code regions by text, symbol, concept, definition, or relationship.",
		promptSnippet: "locate relevant code",
		parameters: grepParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const [adapter, invocationHost] = await Promise.all([loaders.grep(), hostForInvocation()]);
			return adapter.execute(params as GrepParams, {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				...(signal !== undefined ? { signal } : {}),
				host: invocationHost,
				lsp,
				repoMap: repoMapFor(ctx),
			});
		},
		},
		repair: { singleStringField: "query", pathFields: ["path"], pathListFields: ["path"] },
		telemetry: grepTelemetry,
	});

	const readTool = registerObservedTool(pi, {
		tool: {
		name: "read",
		label: "read",
		description: "Read one text, image or skill related file.",
		promptSnippet: "read one file",
		parameters: readParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const [module, invocationHost, index] = await Promise.all([loaders.read(), hostForInvocation(), skillReadIndex()]);
			return module.executeRead(params as ReadParams, {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				...(signal === undefined ? {} : { signal }),
				model: ctx.model,
				host: invocationHost,
				lsp,
				repoMap: repoMapFor(ctx),
				branch: typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [],
				skillIndex: index,
			});
		},
	}, repair: {
		singleStringField: "path",
		pathFields: ["path"],
		aliases: {
			startLine: "start_line",
			endLine: "end_line",
		},
		},
		telemetry: readTelemetry,
	});

	const writeTool = registerObservedTool<typeof writeParameters, ToolOutcome<WriteSuccess> | MutationProgressDetails>(pi, {
		tool: {
		name: "write",
		label: "write",
		description: "Create or overwrite one whole file.",
		promptSnippet: "write one whole file",
		parameters: writeParameters,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const [module, invocationHost] = await Promise.all([loaders.write(), hostForInvocation()]);
			return module.executeWrite(params as WriteParams, {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				...(signal !== undefined ? { signal } : {}),
				host: invocationHost,
				lsp,
				repoMap: repoMapFor(ctx),
				...(onUpdate === undefined ? {} : { onUpdate }),
			});
		},
	}, repair: {
		pathFields: ["path"],
		aliases: {
			text: "content",
			contents: "content",
		},
		},
		telemetry: writeTelemetry,
	});

	const editTool = registerObservedTool<typeof editParameters, ToolOutcome<EditSuccess> | MutationProgressDetails>(pi, {
		tool: {
		name: "edit",
		label: "edit",
		description: "Edit one previously read or written file with exact replacements.",
		promptSnippet: "edit one known file",
		parameters: editParameters,
		renderShell: "self",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const [module, invocationHost] = await Promise.all([loaders.edit(), hostForInvocation()]);
			return module.executeEdit(params as EditParams, {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				...(signal !== undefined ? { signal } : {}),
				host: invocationHost,
				lsp,
				repoMap: repoMapFor(ctx),
				...(onUpdate === undefined ? {} : { onUpdate }),
			});
		},
	}, repair: {
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
		},
		telemetry: editTelemetry,
	});

	let nativeRendererLoad: Promise<void> | undefined;
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (nativeRendererLoad === undefined) {
			const pending = loadRenderers().then((renderers) => {
				pi.registerTool({ ...lsTool, renderCall: renderers.renderLsCall, renderResult: renderers.renderLsResult });
				pi.registerTool({ ...findTool, renderCall: renderers.renderFindCall, renderResult: renderers.renderFindResult });
				pi.registerTool({ ...grepTool, renderCall: renderers.renderGrepCall, renderResult: renderers.renderGrepResult });
				pi.registerTool({ ...readTool, renderCall: renderers.renderReadCall, renderResult: renderers.renderReadResult });
				pi.registerTool({ ...writeTool, renderCall: renderers.renderWriteCall, renderResult: renderers.renderWriteResult });
				pi.registerTool({ ...editTool, renderCall: renderers.renderEditCall, renderResult: renderers.renderEditResult });
			}, (error: unknown) => {
				nativeRendererLoad = undefined;
				ctx.ui.notify(`File tool renderer initialization failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			});
			nativeRendererLoad = pending;
		}
		await nativeRendererLoad;
	});

	pi.on("tool_result", (event) => {
		if (isFileToolName(event.toolName) && isFailedDetails(event.details)) return { isError: true };
		return undefined;
	});
	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		host?.stop();
		for (const instance of loadedToolInstances) instance.dispose();
		for (const repoMap of repoMaps.values()) repoMap.dispose();
		repoMaps.clear();
		await lsp.shutdown();
		host?.dispose();
	});
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
