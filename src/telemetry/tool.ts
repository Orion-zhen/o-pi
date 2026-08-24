import type { ConstrainedSamplingConfig } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import { repairableTool } from "../tool-repair/repair.js";
import type { RepairSpecHints } from "../tool-repair/types.js";
import {
	TELEMETRY_READY_CHANNEL,
	TELEMETRY_REPAIR_CHANNEL,
	TELEMETRY_TOOL_CHANNEL,
	type TelemetryToolRegistration,
} from "./events.js";
import type { ToolTelemetry } from "./types.js";

type ExecutedParams<TParams extends TSchema, TDetails, TState> = Parameters<ToolDefinition<TParams, TDetails, TState>["execute"]>[1];
type ObservedPi = Pick<ExtensionAPI, "events" | "registerTool">;

const PREFERRED_STRICT_SAMPLING = {
	type: "json_schema",
	strict: "prefer",
} satisfies ConstrainedSamplingConfig;

export interface ObservedToolOptions<TParams extends TSchema, TDetails, TState> {
	tool: ToolDefinition<TParams, TDetails, TState>;
	telemetry?: ToolTelemetry<ExecutedParams<TParams, TDetails, TState>, TDetails>;
	repair?: RepairSpecHints;
}

/** Register a tool and announce its payload-free telemetry projection to this Pi runtime. */
export function registerObservedTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
	pi: ObservedPi,
	options: ObservedToolOptions<TParams, TDetails, TState>,
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

export { defineToolTelemetry } from "./projection.js";
