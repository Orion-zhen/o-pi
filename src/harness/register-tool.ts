import type { ConstrainedSamplingConfig } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import { repairableTool } from "./tool-repair/repair.ts";
import type { RepairSpecHints } from "./tool-repair/types.ts";
import {
	TELEMETRY_READY_CHANNEL,
	TELEMETRY_REPAIR_CHANNEL,
	TELEMETRY_TOOL_CHANNEL,
	type TelemetryToolRegistration,
} from "./telemetry/events.ts";
import type { ToolTelemetry } from "./telemetry/types.ts";

type ExecutedParams<TParams extends TSchema, TDetails, TState> = Parameters<ToolDefinition<TParams, TDetails, TState>["execute"]>[1];

const PREFERRED_STRICT_SAMPLING = {
	type: "json_schema",
	strict: "prefer",
} satisfies ConstrainedSamplingConfig;

interface RegisterToolOptions<TParams extends TSchema, TDetails, TState> {
	tool: ToolDefinition<TParams, TDetails, TState>;
	telemetry?: ToolTelemetry<ExecutedParams<TParams, TDetails, TState>, TDetails>;
	repair?: RepairSpecHints;
}

/** 组合采样策略、参数修复和遥测，注册后仍可由 TUI 附加呈现器。 */
export function registerTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
	pi: Pick<ExtensionAPI, "events" | "registerTool">,
	options: RegisterToolOptions<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
	const prepared = repairableTool({
		...options.tool,
		constrainedSampling: options.tool.constrainedSampling ?? PREFERRED_STRICT_SAMPLING,
	}, options.repair, {
		onPreparation(observation) {
			pi.events.emit(TELEMETRY_REPAIR_CHANNEL, observation);
		},
	});
	const registration = eraseRegistration(prepared, options.telemetry);
	const announce = () => pi.events.emit(TELEMETRY_TOOL_CHANNEL, registration);
	pi.events.on(TELEMETRY_READY_CHANNEL, announce);
	pi.registerTool(prepared);
	announce();
	return prepared;
}

function eraseRegistration<TParams extends TSchema, TDetails, TState>(
	tool: ToolDefinition<TParams, TDetails, TState>,
	telemetry: ToolTelemetry<ExecutedParams<TParams, TDetails, TState>, TDetails> | undefined,
): TelemetryToolRegistration {
	const input = telemetry?.input;
	const result = telemetry?.result;
	return {
		definition: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
			...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: tool.promptGuidelines }),
		},
		...(input === undefined ? {} : {
			input: (params: unknown) => input(params as ExecutedParams<TParams, TDetails, TState>),
		}),
		...(result === undefined ? {} : {
			result: (params: unknown, details: unknown) => result(
				params as ExecutedParams<TParams, TDetails, TState>,
				details as TDetails,
			),
		}),
	};
}
