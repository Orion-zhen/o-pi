import { fields, isRecord, scalar, textFields } from "../telemetry/projection.js";
import { defineToolTelemetry } from "../telemetry/tool.js";
import type { Resource, TelemetryFacts } from "../telemetry/types.js";
import type { SubagentDetails, SubagentToolParams } from "./types.js";

export const subagentTelemetry = defineToolTelemetry<SubagentToolParams, SubagentDetails>({
	input: projectInput,
	result(_params, result) {
		const details = result.details;
		let failed = 0;
		let attempts = 0;
		let durationMs = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		for (const item of details.results) {
			if (item.error !== undefined || item.exitCode !== 0) failed += 1;
			attempts += finite(item.attempts);
			durationMs += finite(item.durationMs);
			inputTokens += finite(item.usage.input);
			outputTokens += finite(item.usage.output);
		}
		return {
			fields: fields({
				mode: details.mode,
				task_count: details.tasks.length,
				failed_task_count: failed,
				attempt_count: attempts,
				duration_ms: durationMs,
				input_tokens: inputTokens,
				output_tokens: outputTokens,
			}),
		};
	},
});

function projectInput(value: unknown): TelemetryFacts {
	if (!isRecord(value) || !Array.isArray(value["tasks"])) return {};
	const tasks = value["tasks"].filter(isRecord);
	let chars = 0;
	let lines = 0;
	const agents: string[] = [];
	const targets: Resource[] = [];
	for (const task of tasks) {
		const agent = scalar(task["agent"]);
		if (typeof agent === "string") agents.push(agent);
		const cwd = scalar(task["cwd"]);
		if (typeof cwd === "string") targets.push({ kind: "directory", value: cwd });
		const summary = textFields("task", task["task"]);
		chars += typeof summary["task_chars"] === "number" ? summary["task_chars"] : 0;
		lines += typeof summary["task_lines"] === "number" ? summary["task_lines"] : 0;
	}
	return {
		fields: { input_task_count: tasks.length, input_agents: agents, input_task_chars: chars, input_task_lines: lines },
		...(targets.length === 0 ? {} : { targets }),
	};
}

function finite(value: number): number {
	return Number.isFinite(value) ? value : 0;
}
