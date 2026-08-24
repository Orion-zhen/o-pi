import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	captureExecutorContext,
	completeAgents,
	parsePipeline,
	queryAgentsSummary,
	querySubagentConfigSummary,
	runSubagentCommand,
	runSubagentTasks,
	SUBAGENT_COMMAND_ENTRY,
	SubagentExecutionRegistry,
	type SubagentInteractionPort,
	type SubagentToolParams,
} from "../../src/subagent/index.js";
import { subagentTelemetry } from "../../src/subagent/telemetry.js";
import { registerObservedTool } from "../../src/telemetry/tool.js";

type SubagentTuiModule = typeof import("../../src/subagent/tui/adapter.js");

const taskItem = Type.Object({
	agent: Type.String({ minLength: 1 }),
	task: Type.String({ minLength: 1, description: "Task; {previous} inserts the prior result and enforces sequence." }),
	cwd: Type.Optional(Type.String({ description: "Workspace-relative directory; default workspace." })),
}, { additionalProperties: false });

const subagentParams = Type.Object(
	{
		tasks: Type.Array(taskItem, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

/** 注册轻量 subagent 工具和确定性命令；所有 component 仅由延迟加载的 TUI adapter 创建。 */
export function createSubagentExtension(
	loadTui: () => Promise<SubagentTuiModule> = () => import("../../src/subagent/tui/adapter.js"),
): (pi: ExtensionAPI) => void {
	return function subagentExtension(pi: ExtensionAPI): void {
		const executions = new SubagentExecutionRegistry();
		const subagentTool = registerObservedTool(pi, {
			tool: {
				name: "subagent",
				label: "subagent",
				description: "Delegate bounded tasks to configured agents.",
				promptSnippet: "delegate bounded tasks",
				parameters: subagentParams,
				async execute(toolCallId, params, signal, onUpdate, ctx) {
					if (process.env.PI_SUBAGENT_CHILD === "1") throw new Error("Recursive subagent calls are forbidden.");
					const lease = executions.start(signal);
					try {
						const interaction = createInteraction(ctx);
						return await runSubagentTasks(
							params as SubagentToolParams,
							{
								...captureExecutorContext(pi, {
									cwd: ctx.cwd,
									model: ctx.model,
									sessionManager: ctx.sessionManager,
									systemPrompt: ctx.getSystemPrompt(),
								}, { invocation: "tool", toolCallId }),
								signal: lease.signal,
								...(interaction === undefined ? {} : { interaction }),
							},
							(event) => {
								if (event.phase !== "completed") onUpdate?.(event.result);
							},
						);
					} finally {
						lease.dispose();
					}
				},
			},
			repair: { pathFields: ["tasks.*.cwd"] },
			telemetry: subagentTelemetry,
		});

		let tuiLoad: Promise<SubagentTuiModule> | undefined;
		const requireTui = (): Promise<SubagentTuiModule> => {
			if (tuiLoad === undefined) {
				tuiLoad = loadTui().then((module) => {
					module.registerSubagentTui(pi, subagentTool);
					return module;
				});
			}
			return tuiLoad;
		};
		registerCommandAdapters(pi, executions, requireTui);

		pi.on("session_start", async (_event, ctx) => {
			if (ctx.mode === "tui") await requireTui();
		});
		pi.on("tool_result", (event) => {
			if (event.toolName !== "subagent" || !isSubagentDetails(event.details)) return undefined;
			return event.details.results.some((result) => result.error !== undefined) ? { isError: true } : undefined;
		});
		pi.on("session_shutdown", () => {
			executions.abortAll();
		});
	};
}

function registerCommandAdapters(
	pi: ExtensionAPI,
	executions: SubagentExecutionRegistry,
	requireTui: () => Promise<SubagentTuiModule>,
): void {
	pi.registerCommand("agents", {
		description: "List available subagents",
		handler: async (_args, ctx) => {
			ctx.ui.notify(await queryAgentsSummary(pi, { cwd: ctx.cwd, model: ctx.model }), "info");
		},
	});

	pi.registerCommand("run", {
		description: 'Run subagents: /run scout "task" | reviewer "task"',
		getArgumentCompletions: (prefix) => completeAgents(prefix),
		handler: async (args, ctx) => {
			const parsed = parsePipeline(args);
			if ("error" in parsed) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}

			const progressAdapter = ctx.mode === "tui"
				? (await requireTui()).createSubagentCommandProgressAdapter(ctx.ui)
				: undefined;
			const lease = executions.start(ctx.signal);
			try {
				const interaction = createInteraction(ctx);
				const result = await runSubagentCommand(
					pi,
					{
						cwd: ctx.cwd,
						model: ctx.model,
						sessionManager: ctx.sessionManager,
						systemPrompt: ctx.getSystemPrompt(),
						signal: lease.signal,
						...(interaction === undefined ? {} : { interaction }),
					},
					parsed.tasks,
					progressAdapter?.onProgress,
				);
				if (ctx.mode === "tui") {
					pi.appendEntry(SUBAGENT_COMMAND_ENTRY, result);
					return;
				}
				const failed = result.details.results.some((item) => item.error !== undefined);
				ctx.ui.notify(result.content[0].text, failed ? "error" : "info");
			} finally {
				lease.dispose();
				progressAdapter?.dispose();
			}
		},
	});

	pi.registerCommand("subagent-config", {
		description: "Show subagent config summary",
		handler: async (_args, ctx) => {
			ctx.ui.notify(await querySubagentConfigSummary(ctx.cwd), "info");
		},
	});
}

function createInteraction(ctx: {
	hasUI: boolean;
	ui: { confirm(title: string, message: string): Promise<boolean> };
}): SubagentInteractionPort | undefined {
	if (!ctx.hasUI) return undefined;
	return { confirmWrite: (title, message) => ctx.ui.confirm(title, message) };
}

function isSubagentDetails(value: unknown): value is { results: Array<{ error?: string }> } {
	if (typeof value !== "object" || value === null) return false;
	return Array.isArray(Reflect.get(value, "results"));
}

export default createSubagentExtension();
