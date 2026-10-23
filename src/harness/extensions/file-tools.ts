import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lsParameters } from "../file-tools/ls/schema.ts";
import { findParameters } from "../file-tools/find/schema.ts";
import { grepParameters } from "../file-tools/grep/schema.ts";
import { readParameters } from "../file-tools/read/schema.ts";
import { writeParameters } from "../file-tools/write/schema.ts";
import { editParameters } from "../file-tools/edit/schema.ts";
import { type FileToolRuntime } from "../file-tools/pi/invocation.ts";
import { type FileToolsHost, type SessionObservationSeed } from "../file-tools/runtime/host.ts";
import { type SessionMutationScope } from "../file-tools/runtime/session-mutation.ts";
import {
	createPersistedObservationState,
	FILE_TOOLS_OBSERVATION_STATE,
	readPersistedObservationState,
} from "../file-tools/runtime/session-observation-state.ts";
import { type EditSuccess } from "../file-tools/edit/types.ts";
import { type WriteSuccess } from "../file-tools/write/types.ts";
import { editTelemetry } from "../file-tools/telemetry/edit.ts";
import { findTelemetry } from "../file-tools/telemetry/find.ts";
import { grepTelemetry } from "../file-tools/telemetry/grep.ts";
import { lsTelemetry } from "../file-tools/telemetry/ls.ts";
import { readTelemetry } from "../file-tools/telemetry/read.ts";
import { writeTelemetry } from "../file-tools/telemetry/write.ts";
import { type ToolOutcome } from "../file-tools/shared/result.ts";
import { findOutputSchema, grepOutputSchema } from "../file-tools/pi/search-output.ts";
import { readOutputSchema } from "../file-tools/pi/read-output.ts";
import { MutationBatchCoordinator } from "../file-tools/pi/mutation-batch.ts";
import { type MutationProgressDetails } from "../file-tools/pi/progress.ts";
import { createToolRegistrar, type ToolTelemetrySink } from "../register-tool.ts";
import { collectSkillCandidates } from "../skill-context/loader.ts";
import { buildSkillFilesystemAccess, buildSkillPathIndex } from "../skill-context/resources.ts";
import { SkillBranchState } from "../skill-context/state.ts";

export default function fileTools(pi: ExtensionAPI, telemetry?: ToolTelemetrySink): void {
	const registerTool = createToolRegistrar(pi, telemetry);
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
	const mutationBatches = new MutationBatchCoordinator(lsp);
	const sessionMutations = new Map<string, SessionMutationScope>();
	const skills = new SkillBranchState();
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
			pathAccess: await buildSkillFilesystemAccess(skills.read(ctx.sessionManager), index),
		};
	};

	registerTool({
		tool: {
			name: "ls",
			label: "ls",
			description: "List direct entries of one directory.",
			promptSnippet: "list one directory",
			parameters: lsParameters,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const [module, runtime] = await Promise.all([import("../file-tools/pi/adapters/ls.ts"), runtimeForInvocation(ctx, signal)]);
				return module.executeLs(params, runtime);
			},
		},
		repair: { singleStringField: "path", pathFields: ["path"] },
		telemetry: lsTelemetry,
	});

	registerTool({
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
				return module.executeFind(params, runtime);
			},
		},
		repair: { singleStringField: "query", pathFields: ["path"], pathListFields: ["path"] },
		telemetry: findTelemetry,
	});

	registerTool({
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
				return adapter.execute(params, {
					...runtime,
					lsp,
					tokenScope: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : {},
				});
			},
		},
		repair: { singleStringField: "query", pathFields: ["path"], pathListFields: ["path"] },
		telemetry: grepTelemetry,
	});

	registerTool({
		tool: {
			name: "read",
			label: "read",
			description: "Read one text, image or PDF file.",
			promptSnippet: "read one file",
			parameters: readParameters,
			outputSchema: readOutputSchema,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const [module, runtime] = await Promise.all([import("../file-tools/pi/adapters/read.ts"), runtimeForInvocation(ctx, signal)]);
				return module.executeRead(params, { ...runtime, model: ctx.model, lsp });
			},
		},
		repair: {
			singleStringField: "path",
			pathFields: ["path"],
		},
		telemetry: readTelemetry,
	});

	registerTool<typeof writeParameters, ToolOutcome<WriteSuccess> | MutationProgressDetails>({
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
					return await module.executeWrite(params, {
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

	registerTool<typeof editParameters, ToolOutcome<EditSuccess> | MutationProgressDetails>({
		tool: {
			name: "edit",
			label: "edit",
			description: "Edit one previously read or written file with exact replacements.",
			promptSnippet: "edit one known file",
			parameters: editParameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const batch = mutationBatches.invocation(toolCallId);
				try {
					const [module, runtime] = await Promise.all([import("../file-tools/pi/adapters/edit.ts"), runtimeForInvocation(ctx, signal)]);
					return await module.executeEdit(params, {
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

	pi.on("session_start", (event, ctx) => {
		const persisted =
			event.reason === "reload" ? readPersistedObservationState(ctx.sessionManager.getBranch()) : undefined;
		restoredSession =
			persisted === undefined
				? undefined
				: {
						sessionId: ctx.sessionManager.getSessionId(),
						observations: persisted.observations,
					};
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
		const pathAccess = await buildSkillFilesystemAccess(skills.read(ctx.sessionManager), index);
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
