import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isFailedDetails, isFileToolName } from "../../src/file-tools/pi/guards.js";
import { createLazyLspFileOperations } from "../../src/file-tools/pi/lazy-lsp.js";
import type { LsParams } from "../../src/file-tools/ls/types.js";
import type { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import type { SessionMutationScope } from "../../src/file-tools/runtime/session-mutation.js";
import { READ_RANGE_PATTERN } from "../../src/file-tools/read/range.js";
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
import { MutationBatchCoordinator } from "../../src/file-tools/pi/mutation-batch.js";
import type { MutationProgressDetails } from "../../src/file-tools/pi/progress.js";
import { registerObservedTool } from "../../src/telemetry/tool.js";
import { collectSkillCandidates } from "../../src/skill-context/loader.js";
import { buildSkillFilesystemAccess, buildSkillPathIndex } from "../../src/skill-context/resources.js";

const lsParameters = Type.Object({ path: Type.Optional(Type.String({ minLength: 1, description: "Directory; default workspace." })) }, { additionalProperties: false });
const findParameters = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			maxLength: 512,
			description: "fzf query: spaces AND; | OR; ' exact; ^ prefix; $ suffix; ! inverse.",
		}),
		path: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Search roots; OR/union scope; default workspace." })),
		glob: Type.Optional(Type.String({ minLength: 1, description: "Candidate path glob relative to each scope." })),
	},
	{ additionalProperties: false },
);
const grepParameters = Type.Object(
	{
		query: Type.String({ minLength: 1, description: "Case-sensitive line query; valid ECMAScript regex, or exact literal fallback only when it matches." }),
		path: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "File or directory scopes; OR/union scope; default workspace." })),
		glob: Type.Optional(Type.String({ minLength: 1, description: "Relative to each scope; without / matches basenames recursively; use a path pattern such as src/**/*.ts for scoped paths." })),
	},
	{ additionalProperties: false },
);
const readParameters = Type.Object(
	{
		path: Type.String({ description: "Text, image or PDF file path." }),
		lines: Type.Optional(Type.String({
			minLength: 1,
			pattern: READ_RANGE_PATTERN,
			description: "Text only line range: N, N-M, or N-; 1-based inclusive.",
		})),
		pages: Type.Optional(Type.String({
			minLength: 1,
			pattern: READ_RANGE_PATTERN,
			description: "PDF only page range: N, N-M, or N-; 1-based inclusive.",
		})),
	},
	{ additionalProperties: false, not: { required: ["lines", "pages"] } },
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
				old: Type.String({ minLength: 1, description: "Exact text in original content. Must be unique unless replace_all is true." }),
				new: Type.String(),
				replace_all: Type.Optional(Type.Boolean({ default: false, description: "Replace ALL old matches; default false." })),
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
	renderers?: () => Promise<typeof import("../../src/file-tools/tui/index.js")>;
	lsp(): Promise<typeof import("../../src/lsp/index.js")>;
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
};

export function createFileToolsExtension(importOverrides: Partial<FileToolsModuleImports> = {}): (pi: ExtensionAPI) => void {
	const imports: FileToolsModuleImports = { ...defaultModuleImports, ...importOverrides };
	return (pi) => {
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
		};
		const loadRenderers = createRetryableLoader(imports.renderers ?? (() => import("../../src/file-tools/tui/index.js")));
		registerFileTools(pi, loaders, loadedToolInstances, loaders.host, loadRenderers);
	};
}

/** 注册覆盖版 ls/find/grep/read/write/edit；扩展层只适配 Pi，工具实现和渲染细节在 src/file-tools。 */
function registerFileTools(
	pi: ExtensionAPI,
	loaders: FileToolsLoaders,
	loadedToolInstances: ReadonlySet<{ dispose(): void }>,
	loadHost: () => Promise<typeof import("../../src/file-tools/runtime/host.js")>,
	loadRenderers: () => Promise<typeof import("../../src/file-tools/tui/index.js")>,
): void {
	let host: FileToolsHost | undefined;
	let shuttingDown = false;
	const hostForInvocation = async (): Promise<FileToolsHost> => {
		const { FileToolsHost: Host } = await loadHost();
		if (host === undefined) host = new Host();
		if (shuttingDown) host.stop();
		return host;
	};
	const lsp = createLazyLspFileOperations(loaders.lsp);
	const mutationBatches = new MutationBatchCoordinator();
	let sessionMutation: SessionMutationScope | undefined;
	const skillPathIndex = createRetryableLoader(async () => buildSkillPathIndex(
		collectSkillCandidates(undefined, typeof pi.getCommands === "function" ? pi.getCommands() : []),
	));

	const lsTool = registerObservedTool(pi, {
		tool: {
		name: "ls",
		label: "ls",
		description: "List direct entries of one directory.",
		promptSnippet: "list one directory",
		parameters: lsParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const [module, invocationHost, index] = await Promise.all([loaders.ls(), hostForInvocation(), skillPathIndex()]);
			const pathAccess = await buildSkillFilesystemAccess(ctx.sessionManager.getBranch(), index);
			return module.executeLs(params as LsParams, {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				...(signal === undefined ? {} : { signal }),
				host: invocationHost,
				pathAccess,
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
		description: "Fuzzy-search file and directory paths.",
		promptSnippet: "fuzzy-search paths",
		parameters: findParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const [adapter, invocationHost, index] = await Promise.all([loaders.find(), hostForInvocation(), skillPathIndex()]);
			const pathAccess = await buildSkillFilesystemAccess(ctx.sessionManager.getBranch(), index);
			return adapter.execute(params as FindParams, {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				...(signal !== undefined ? { signal } : {}),
				host: invocationHost,
				pathAccess,
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
		description: "Search texts in the codebase.",
		promptSnippet: "locate relevant code",
		parameters: grepParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const [adapter, invocationHost, index] = await Promise.all([loaders.grep(), hostForInvocation(), skillPathIndex()]);
			const pathAccess = await buildSkillFilesystemAccess(ctx.sessionManager.getBranch(), index);
			return adapter.execute(params as GrepParams, {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				...(signal !== undefined ? { signal } : {}),
				host: invocationHost,
				lsp,
				pathAccess,
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
		description: "Read one text, image or PDF file.",
		promptSnippet: "read one file",
		parameters: readParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const [module, invocationHost, index] = await Promise.all([loaders.read(), hostForInvocation(), skillPathIndex()]);
			const pathAccess = await buildSkillFilesystemAccess(ctx.sessionManager.getBranch(), index);
			return module.executeRead(params as ReadParams, {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				...(signal === undefined ? {} : { signal }),
				model: ctx.model,
				host: invocationHost,
				lsp,
				pathAccess,
			});
		},
	}, repair: {
		singleStringField: "path",
		pathFields: ["path"],
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
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const batch = mutationBatches.invocation(toolCallId);
			try {
				const [module, invocationHost, index] = await Promise.all([loaders.write(), hostForInvocation(), skillPathIndex()]);
				const pathAccess = await buildSkillFilesystemAccess(ctx.sessionManager.getBranch(), index);
				return await module.executeWrite(params as WriteParams, {
					cwd: ctx.cwd,
					sessionId: ctx.sessionManager.getSessionId(),
					...(signal !== undefined ? { signal } : {}),
					host: invocationHost,
					lsp,
					...(onUpdate === undefined ? {} : { onUpdate }),
					...(batch === undefined ? {} : { batch }),
					pathAccess,
				});
			} finally {
				batch?.settle();
			}
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
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const batch = mutationBatches.invocation(toolCallId);
			try {
				const [module, invocationHost, index] = await Promise.all([loaders.edit(), hostForInvocation(), skillPathIndex()]);
				const pathAccess = await buildSkillFilesystemAccess(ctx.sessionManager.getBranch(), index);
				return await module.executeEdit(params as EditParams, {
					cwd: ctx.cwd,
					sessionId: ctx.sessionManager.getSessionId(),
					...(signal !== undefined ? { signal } : {}),
					host: invocationHost,
					lsp,
					...(onUpdate === undefined ? {} : { onUpdate }),
					...(batch === undefined ? {} : { batch }),
					pathAccess,
				});
			} finally {
				batch?.settle();
			}
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

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		mutationBatches.capture(event.message.content.flatMap((item) => item.type === "toolCall"
			? [{ id: item.id, name: item.name }]
			: []));
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		mutationBatches.started(event.toolCallId);
		if (event.toolName !== "bash" || host === undefined) return;
		const index = await skillPathIndex();
		const pathAccess = await buildSkillFilesystemAccess(ctx.sessionManager.getBranch(), index);
		sessionMutation = await host.beginSessionMutation({
			cwd: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId(),
			pathAccess,
		});
	});
	pi.on("tool_execution_end", async (event) => {
		mutationBatches.ended(event.toolCallId);
		if (event.toolName !== "bash") return;
		const scope = sessionMutation;
		sessionMutation = undefined;
		await scope?.finish();
	});
	pi.on("tool_result", (event) => {
		if (isFileToolName(event.toolName) && isFailedDetails(event.details)) return { isError: true };
		return undefined;
	});
	pi.on("session_shutdown", () => {
		shuttingDown = true;
		mutationBatches.dispose();
		sessionMutation?.dispose();
		sessionMutation = undefined;
		host?.stop();
		for (const instance of loadedToolInstances) instance.dispose();
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
