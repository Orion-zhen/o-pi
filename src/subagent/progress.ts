import { executeSubagent, resolveMode } from "./executor.js";
import type {
	ExecutorContext,
	SubagentProgressCallback,
	SubagentTask,
	SubagentToolParams,
	SubagentToolResult,
} from "./types.js";

/** 统一 model tool 与 /run 的 starting/running/completed 进度协议。 */
export async function runSubagentTasks(
	params: SubagentToolParams,
	context: ExecutorContext,
	onProgress?: SubagentProgressCallback,
): Promise<SubagentToolResult> {
	onProgress?.({ phase: "starting", result: pendingSubagentResult(params.tasks) });
	const upstreamUpdate = context.onUpdate;
	const result = await executeSubagent(params, {
		...context,
		onUpdate(partial) {
			upstreamUpdate?.(partial);
			onProgress?.({ phase: "running", result: partial });
		},
	});
	onProgress?.({ phase: "completed", result });
	return result;
}

export function pendingSubagentResult(tasks: readonly SubagentTask[]): SubagentToolResult {
	return {
		content: [{ type: "text", text: "Subagents starting" }],
		details: {
			mode: resolveMode([...tasks]),
			runId: "pending",
			tasks: tasks.map((task) => ({ ...task })),
			results: [],
			warnings: [],
		},
	};
}
