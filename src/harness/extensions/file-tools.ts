import { type ToolCallRenderer, type ToolResultRenderer } from "../presentation.ts";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type LsParams } from "../file-tools/ls/types.ts";
import { type FileToolRuntime } from "../file-tools/pi/invocation.ts";
import { type FileToolsHost, type SessionObservationSeed } from "../file-tools/runtime/host.ts";
import { type SessionMutationScope } from "../file-tools/runtime/session-mutation.ts";
import {
	createPersistedObservationState,
	FILE_TOOLS_OBSERVATION_STATE,
	readPersistedObservationState,
} from "../file-tools/runtime/session-observation-state.ts";
import { READ_RANGE_PATTERN } from "../content-ranges.ts";
import { type ReadParams } from "../file-tools/read/types.ts";
import { type EditParams, type EditSuccess } from "../file-tools/edit/types.ts";
import { type FindParams } from "../file-tools/find/types.ts";
import { type GrepParams } from "../file-tools/grep/types.ts";
import { type WriteParams, type WriteSuccess } from "../file-tools/write/types.ts";
import { editTelemetry } from "../file-tools/telemetry/edit.ts";
import { findTelemetry } from "../file-tools/telemetry/find.ts";
import { grepTelemetry } from "../file-tools/telemetry/grep.ts";
import { lsTelemetry } from "../file-tools/telemetry/ls.ts";
import { readTelemetry } from "../file-tools/telemetry/read.ts";
import { writeTelemetry } from "../file-tools/telemetry/write.ts";
import { type ToolOutcome } from "../file-tools/shared/result.ts";
import { findOutputSchema, grepOutputSchema } from "../file-tools/pi/search-output.ts";
import { MutationBatchCoordinator } from "../file-tools/pi/mutation-batch.ts";
import { type MutationProgressDetails } from "../file-tools/pi/progress.ts";
import { registerTool } from "../register-tool.ts";
import { collectSkillCandidates } from "../skill-context/loader.ts";
import { buildSkillFilesystemAccess, buildSkillPathIndex } from "../skill-context/resources.ts";

const lsParameters = Type.Object(
	{ path: Type.Optional(Type.String({ minLength: 1, description: "Directory; default workspace." })) },
	{ additionalProperties: false },
);
const findParameters = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			maxLength: 512,
			description: "fzf query: spaces AND; | OR; ' exact; ^ prefix; $ suffix; ! inverse.",
		}),
		path: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				description: "Search roots; OR/union scope; default workspace.",
			}),
		),
		glob: Type.Optional(Type.String({ minLength: 1, description: "Candidate path glob relative to each scope." })),
	},
	{ additionalProperties: false },
);
const grepParameters = Type.Object(
	{
		query: Type.String({ minLength: 1, description: "Case-sensitive line query." }),
		mode: Type.Optional(
			Type.Union([Type.Literal("regex"), Type.Literal("literal")], {
				default: "regex",
				description: "ECMAScript regex or exact text.",
			}),
		),
		path: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				description: "File or directory scopes; OR/union scope; default workspace.",
			}),
		),
		glob: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"Relative to each scope; without / matches basenames recursively; use a path pattern such as src/**/*.ts for scoped paths.",
			}),
		),
	},
	{ additionalProperties: false },
);
const readParameters = Type.Object(
	{
		path: Type.String({ description: "Text, image or PDF file path." }),
		lines: Type.Optional(
			Type.String({
				minLength: 1,
				pattern: READ_RANGE_PATTERN,
				description: "Text line ranges: N, N-M, or N-, supports multiple comma-separated ranges; 1-based inclusive.",
			}),
		),
		pages: Type.Optional(
			Type.String({
				minLength: 1,
				pattern: READ_RANGE_PATTERN,
				description: "PDF page ranges: N, N-M, or N-, supports multiple comma-separated ranges; 1-based inclusive.",
			}),
		),
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
const editParameters = Type.Object(
	{
		path: Type.String({ description: "Previously read or written file." }),
		edits: Type.Array(
			Type.Object(
				{
					old: Type.String({
						minLength: 1,
						description: "Exact text in original content. Must be unique unless replace_all is true.",
					}),
					new: Type.String(),
					replace_all: Type.Optional(
						Type.Boolean({ default: false, description: "Replace ALL old matches; default false." }),
					),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, description: "Non-overlapping replacements against original content." },
		),
	},
	{ additionalProperties: false },
);

export interface FileToolRenderers {
	renderLsCall: ToolCallRenderer;
	renderLsResult: ToolResultRenderer;
	renderFindCall: ToolCallRenderer;
	renderFindResult: ToolResultRenderer;
	renderGrepCall: ToolCallRenderer;
	renderGrepResult: ToolResultRenderer;
	renderReadCall: ToolCallRenderer;
	renderReadResult: ToolResultRenderer;
	renderWriteCall: ToolCallRenderer;
	renderWriteResult: ToolResultRenderer;
	renderEditCall: ToolCallRenderer;
	renderEditResult: ToolResultRenderer;
}

export function createFileToolsExtension(loadRenderers?: () => Promise<FileToolRenderers>): (pi: ExtensionAPI) => void {
	return (pi) => registerFileTools(pi, loadRenderers);
}

function registerFileTools(pi: ExtensionAPI, loadRenderers?: () => Promise<FileToolRenderers>): void {
	type GrepAdapter = ReturnType<(typeof import("../file-tools/pi/adapters/grep.ts"))["createGrepAdapter"]>;
	let grep: Promise<GrepAdapter> | undefined;
	let grepAdapter: GrepAdapter | undefined;
	const loadGrep = () => grep ??= import("../file-tools/pi/adapters/grep.ts").then(({ createGrepAdapter }) => {
		grepAdapter = createGrepAdapter();
		if (shuttingDown) grepAdapter.dispose();
		return grepAdapter;
	});
	let host: FileToolsHost | undefined;
	let restoredSession: SessionObservationSeed | undefined;
	let shuttingDown = false;
	const hostForInvocation = async (): Promise<FileToolsHost> => {
		const { FileToolsHost: Host } = await import("../file-tools/runtime/host.ts");
		if (host === undefined) {
			host = new Host(restoredSession === undefined ? {} : { initialSession: restoredSession });
			restoredSession = undefined;
		}
		if (shuttingDown) host.stop();
		return host;
	};
	const lsp = async () => (await import("../lsp/index.ts")).lspManager;
	const mutationBatches = new MutationBatchCoordinator();
	const sessionMutations = new Map<string, SessionMutationScope>();
	const skillPathIndex = createRetryableLoader(async () =>
		buildSkillPathIndex(
			collectSkillCandidates(undefined, pi.getCommands()),
		),
	);

	const runtimeForInvocation = async (
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<FileToolRuntime> => {
		const [invocationHost, index] = await Promise.all([hostForInvocation(), skillPathIndex()]);
		return {
			cwd: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId(),
			...(signal === undefined ? {} : { signal }),
			host: invocationHost,
			pathAccess: await buildSkillFilesystemAccess(ctx.sessionManager.getBranch(), index),
		};
	};

	const lsTool = registerTool(pi, {
		tool: {
			name: "ls",
			label: "ls",
			description: "List direct entries of one directory.",
			promptSnippet: "list one directory",
			parameters: lsParameters,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const [module, runtime] = await Promise.all([import("../file-tools/pi/adapters/ls.ts"), runtimeForInvocation(ctx, signal)]);
				return module.executeLs(params as LsParams, runtime);
			},
		},
		repair: { singleStringField: "path", pathFields: ["path"] },
		telemetry: lsTelemetry,
	});

	const findTool = registerTool(pi, {
		tool: {
			name: "find",
			label: "find",
			description: "Fuzzy-search file and directory paths.",
			promptSnippet: "fuzzy-search paths",
			parameters: findParameters,
			outputSchema: findOutputSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const [module, runtime] = await Promise.all([import("../file-tools/pi/adapters/find.ts"), runtimeForInvocation(ctx, signal)]);
				return module.executeFind(params as FindParams, runtime);
			},
		},
		repair: { singleStringField: "query", pathFields: ["path"], pathListFields: ["path"] },
		telemetry: findTelemetry,
	});

	const grepTool = registerTool(pi, {
		tool: {
			name: "grep",
			label: "grep",
			description: "Search texts in the codebase.",
			promptSnippet: "locate relevant code",
			parameters: grepParameters,
			outputSchema: grepOutputSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const [adapter, runtime] = await Promise.all([loadGrep(), runtimeForInvocation(ctx, signal)]);
				return adapter.execute(params as GrepParams, { ...runtime, lsp });
			},
		},
		repair: { singleStringField: "query", pathFields: ["path"], pathListFields: ["path"] },
		telemetry: grepTelemetry,
	});

	const readTool = registerTool(pi, {
		tool: {
			name: "read",
			label: "read",
			description: "Read one text, image or PDF file.",
			promptSnippet: "read one file",
			parameters: readParameters,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const [module, runtime] = await Promise.all([import("../file-tools/pi/adapters/read.ts"), runtimeForInvocation(ctx, signal)]);
				return module.executeRead(params as ReadParams, { ...runtime, model: ctx.model, lsp });
			},
		},
		repair: {
			singleStringField: "path",
			pathFields: ["path"],
		},
		telemetry: readTelemetry,
	});

	const writeTool = registerTool<typeof writeParameters, ToolOutcome<WriteSuccess> | MutationProgressDetails>(pi, {
		tool: {
			name: "write",
			label: "write",
			description: "Create or overwrite one whole file.",
			promptSnippet: "write one whole file",
			parameters: writeParameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const batch = mutationBatches.invocation(toolCallId);
				try {
					const [module, runtime] = await Promise.all([import("../file-tools/pi/adapters/write.ts"), runtimeForInvocation(ctx, signal)]);
					return await module.executeWrite(params as WriteParams, {
						...runtime,
						lsp,
						...(onUpdate === undefined ? {} : { onUpdate }),
						...(batch === undefined ? {} : { batch }),
					});
				} finally {
					batch?.settle();
				}
			},
		},
		repair: {
			pathFields: ["path"],
			aliases: {
				text: "content",
				contents: "content",
			},
		},
		telemetry: writeTelemetry,
	});

	const editTool = registerTool<typeof editParameters, ToolOutcome<EditSuccess> | MutationProgressDetails>(pi, {
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
					const [module, runtime] = await Promise.all([import("../file-tools/pi/adapters/edit.ts"), runtimeForInvocation(ctx, signal)]);
					return await module.executeEdit(params as EditParams, {
						...runtime,
						lsp,
						...(onUpdate === undefined ? {} : { onUpdate }),
						...(batch === undefined ? {} : { batch }),
					});
				} finally {
					batch?.settle();
				}
			},
		},
		repair: {
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
	pi.on("session_start", async (event, ctx) => {
		const persisted =
			event.reason === "reload" ? readPersistedObservationState(ctx.sessionManager.getBranch()) : undefined;
		restoredSession =
			persisted === undefined
				? undefined
				: {
						sessionId: ctx.sessionManager.getSessionId(),
						observations: persisted.observations,
					};
		if (ctx.mode !== "tui" || loadRenderers === undefined) return;
		nativeRendererLoad ??= loadRenderers().then((renderers) => {
			pi.registerTool({ ...lsTool, renderCall: renderers.renderLsCall, renderResult: renderers.renderLsResult });
			pi.registerTool({ ...findTool, renderCall: renderers.renderFindCall, renderResult: renderers.renderFindResult });
			pi.registerTool({ ...grepTool, renderCall: renderers.renderGrepCall, renderResult: renderers.renderGrepResult });
			pi.registerTool({ ...readTool, renderCall: renderers.renderReadCall, renderResult: renderers.renderReadResult });
			pi.registerTool({ ...writeTool, renderCall: renderers.renderWriteCall, renderResult: renderers.renderWriteResult });
			pi.registerTool({ ...editTool, renderShell: "self", renderCall: renderers.renderEditCall, renderResult: renderers.renderEditResult });
		});
		await nativeRendererLoad;
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		mutationBatches.capture(
			event.message.content.flatMap((item) => (item.type === "toolCall" ? [{ id: item.id, name: item.name }] : [])),
		);
	});
	pi.on("tool_execution_start", (event) => mutationBatches.started(event.toolCallId));
	// 嵌套调用在入队前发出 execution_start，参数校验和审批钩子才位于执行队列内。
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" || host === undefined) return;
		const index = await skillPathIndex();
		const pathAccess = await buildSkillFilesystemAccess(ctx.sessionManager.getBranch(), index);
		const scope = await host.beginSessionMutation({
			cwd: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId(),
			pathAccess,
		});
		if (scope) sessionMutations.set(event.toolCallId, scope);
	});
	pi.on("tool_result", async (event) => {
		const scope = sessionMutations.get(event.toolCallId);
		sessionMutations.delete(event.toolCallId);
		await scope?.finish();
	});
	pi.on("tool_execution_end", (event) => {
		mutationBatches.ended(event.toolCallId);
		// 校验后被其他钩子阻止或取消的调用没有 tool_result，不采纳文件变化。
		sessionMutations.get(event.toolCallId)?.dispose();
		sessionMutations.delete(event.toolCallId);
	});
	pi.on("session_shutdown", (event, ctx) => {
		if (event.reason === "reload" && host !== undefined) {
			const observations = host.sessionObservations(ctx.sessionManager.getSessionId());
			if (observations.length > 0) {
				pi.appendEntry(FILE_TOOLS_OBSERVATION_STATE, createPersistedObservationState(observations));
			}
		}
		shuttingDown = true;
		restoredSession = undefined;
		mutationBatches.dispose();
		for (const scope of sessionMutations.values()) scope.dispose();
		sessionMutations.clear();
		host?.stop();
		grepAdapter?.dispose();
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
