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
});

const subagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name for single mode." })),
	task: Type.Optional(Type.String({ description: "Task for single mode." })),
	tasks: Type.Optional(Type.Array(taskItem, { description: "Parallel tasks." })),
	chain: Type.Optional(Type.Array(taskItem, { description: "Sequential tasks. Use {previous} for prior result." })),
	cwd: Type.Optional(Type.String({ description: "Workspace-relative working directory." })),
	model: Type.Optional(Type.String({ description: "Model for this call only." })),
	outputMode: Type.Optional(StringEnum(["inline", "file"] as const, { description: "Return short inline text or file reference." })),
});

/** 注册轻量 subagent 工具和确定性命令；核心逻辑在 src/subagent。 */
export default function subagentExtension(pi: ExtensionAPI): void {
	registerSubagentCommands(pi);
	pi.registerTool({
		name: "subagent",
		label: "subagent",
		description: "Run isolated Pi subagents in single, parallel, or chain mode. Provide exactly one mode.",
		promptSnippet: "Delegate a bounded task to a named isolated subagent",
		promptGuidelines: [
			"Pass explicit task text; do not ask subagents to loosen permissions.",
			"Use file output for long results or parallel work.",
		],
		parameters: subagentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const modelIds = ctx.modelRegistry.getAll().map((model) => model.id);
			return executeSubagent(params as SubagentToolParams, {
				cwd: ctx.cwd,
					hasUI: ctx.hasUI,
					currentModel: ctx.model?.id,
					modelIds,
					activeTools: pi.getActiveTools(),
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
