import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	executeSubagent,
	formatModelReference,
	registerSubagentCommands,
	renderSubagentCall,
	renderSubagentResult,
	type SubagentToolParams,
} from "../../src/subagent/index.js";
import { repairableTool } from "../../src/tool-repair/index.js";

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
	pi.registerTool(repairableTool({
		name: "subagent",
		label: "subagent",
		description: "Delegate bounded tasks to isolated agents.",
		promptSnippet: "delegate bounded tasks",
		parameters: subagentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeSubagent(params as SubagentToolParams, {
				cwd: ctx.cwd,
				hasUI: ctx.hasUI,
				currentModel: formatModelReference(ctx.model),
				registeredTools: pi.getAllTools().map((tool) => tool.name),
				...(signal !== undefined ? { signal } : {}),
				...(ctx.hasUI ? { confirm: (title: string, message: string) => ctx.ui.confirm(title, message) } : {}),
				...(onUpdate !== undefined ? { onUpdate } : {}),
			});
		},
		renderCall: renderSubagentCall,
		renderResult: renderSubagentResult,
	}, {
		pathFields: ["tasks.*.cwd"],
	}));
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
