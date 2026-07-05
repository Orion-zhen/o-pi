import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	executeSubagent,
	registerSubagentCommands,
	renderSubagentCall,
	renderSubagentResult,
	type SubagentToolParams,
} from "../../src/subagent/index.js";

const taskItem = Type.Object({
	agent: Type.String({ minLength: 1, description: "Agent name." }),
	task: Type.String({ minLength: 1, description: "Task text." }),
	cwd: Type.Optional(Type.String({ description: "Workspace-relative working directory." })),
}, { additionalProperties: false });

const commonSubagentFields = {
	cwd: Type.Optional(Type.String({ description: "Workspace-relative working directory." })),
	outputMode: Type.Optional(
		StringEnum(["inline", "file"] as const, {
			description: "inline for short results; file for long or multi-task results.",
		}),
	),
};

const subagentParams = Type.Object(
	{
		tasks: Type.Array(taskItem, { minItems: 1, description: "Agent tasks." }),
		mode: Type.Optional(Type.Literal("chain", { description: "Run tasks sequentially; task may use {previous}." })),
		...commonSubagentFields,
	},
	{ additionalProperties: false },
);

/** 注册轻量 subagent 工具和确定性命令；核心逻辑在 src/subagent。 */
export default function subagentExtension(pi: ExtensionAPI): void {
	registerSubagentCommands(pi);
	pi.registerTool({
		name: "subagent",
		label: "subagent",
		description: "Delegate one or more bounded tasks to isolated agents.",
		promptSnippet: "delegate bounded isolated work",
		parameters: subagentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeSubagent(params as SubagentToolParams, {
				cwd: ctx.cwd,
				hasUI: ctx.hasUI,
				currentModel: ctx.model?.id,
				registeredTools: pi.getAllTools().map((tool) => tool.name),
				...(signal !== undefined ? { signal } : {}),
				...(ctx.hasUI ? { confirm: (title: string, message: string) => ctx.ui.confirm(title, message) } : {}),
				...(onUpdate !== undefined ? { onUpdate } : {}),
			});
		},
		renderCall: renderSubagentCall,
		renderResult: renderSubagentResult,
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return undefined;
		const details = event.details;
		if (!isSubagentDetails(details)) return undefined;
		return details.results.some((result) => result.error !== undefined) ? { isError: true } : undefined;
	});
}

function isSubagentDetails(value: unknown): value is { results: Array<{ error?: string }> } {
	return typeof value === "object" && value !== null && Array.isArray((value as { results?: unknown }).results);
}
