import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	captureExecutorContext,
	executeSubagent,
	registerSubagentCommands,
	renderSubagentCall,
	renderSubagentCommandEntry,
	renderSubagentResult,
	SUBAGENT_COMMAND_ENTRY,
	type SubagentToolParams,
} from "../../src/subagent/index.js";
import { subagentTelemetry } from "../../src/subagent/telemetry.js";
import { registerObservedTool } from "../../src/telemetry/tool.js";

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

/** 注册轻量 subagent 工具和确定性命令；核心逻辑在 src/subagent。 */
export default function subagentExtension(pi: ExtensionAPI): void {
	registerSubagentCommands(pi);
	pi.registerEntryRenderer(SUBAGENT_COMMAND_ENTRY, (entry, { expanded }, theme) => {
		return renderSubagentCommandEntry(entry.data, expanded, theme);
	});
	registerObservedTool(pi, {
		tool: {
			name: "subagent",
			label: "subagent",
			description: "Delegate bounded tasks to configured agents.",
			promptSnippet: "delegate bounded tasks",
			parameters: subagentParams,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_FORK === "1") {
					return {
						content: [{ type: "text", text: "Recursive subagent calls are forbidden." }],
						details: { mode: "parallel" as const, runId: "blocked", tasks: [], results: [], warnings: [] },
					};
				}
				return executeSubagent(params as SubagentToolParams, {
					...captureExecutorContext(pi, ctx, "tool", toolCallId),
					hasUI: ctx.hasUI,
					...(signal !== undefined ? { signal } : {}),
					...(ctx.hasUI ? { confirm: (title: string, message: string) => ctx.ui.confirm(title, message) } : {}),
					...(onUpdate !== undefined ? { onUpdate } : {}),
				});
			},
			renderCall: renderSubagentCall,
			renderResult: renderSubagentResult,
		},
		repair: { pathFields: ["tasks.*.cwd"] },
		telemetry: subagentTelemetry,
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return undefined;
		const details = event.details;
		if (!isSubagentDetails(details)) return undefined;
		return details.runId === "blocked" || details.results.some((result) => result.error !== undefined) ? { isError: true } : undefined;
	});
}

function isSubagentDetails(value: unknown): value is { runId?: string; results: Array<{ error?: string }> } {
	return typeof value === "object" && value !== null && Array.isArray((value as { results?: unknown }).results);
}
