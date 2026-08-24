import { fields } from "../telemetry/projection.js";
import { defineToolTelemetry } from "../telemetry/tool.js";
import type { Resource, TelemetryFacts } from "../telemetry/types.js";
import type { SubagentDetails, SubagentToolParams } from "./types.js";

export const subagentTelemetry = defineToolTelemetry<SubagentToolParams, SubagentDetails>({
	input: projectInput,
	result(_params, details) {
		let failed = 0;
		let durationMs = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		for (const item of details.results) {
			if (item.error !== undefined || (item.status === "completed" && item.exitCode !== 0)) failed += 1;
			durationMs += item.durationMs;
			inputTokens += item.usage.input;
			outputTokens += item.usage.output;
		}
		return {
			fields: fields({
				mode: details.mode,
				task_count: details.tasks.length,
				failed_task_count: failed,
				duration_ms: durationMs,
				input_tokens: inputTokens,
				output_tokens: outputTokens,
			}),
		};
	},
});

function projectInput(params: SubagentToolParams): TelemetryFacts {
	let chars = 0;
	let lines = 0;
	const agents: string[] = [];
	const targets: Resource[] = [];
	for (const task of params.tasks) {
		agents.push(task.agent);
		if (task.cwd !== undefined) targets.push({ kind: "directory", value: task.cwd });
		chars += task.task.length;
		lines += lineCount(task.task);
	}
	return {
		fields: { input_task_count: params.tasks.length, input_agents: agents, input_task_chars: chars, input_task_lines: lines },
		...(targets.length === 0 ? {} : { targets }),
	};
}

function lineCount(value: string): number {
	if (value.length === 0) return 0;
	let lines = 1;
	for (let index = 0; index < value.length; index += 1) {
		if (value.charCodeAt(index) === 10) lines += 1;
	}
	return lines;
}
