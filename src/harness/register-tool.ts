import type { ConstrainedSamplingConfig } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import { repairableTool, type RepairableToolDefinition, type ToolArguments } from "./tool-repair/repair.ts";
import type { RepairSpecHints } from "./tool-repair/types.ts";
import type { TelemetryService } from "./telemetry/service.ts";
import type { TelemetryToolRegistration, ToolTelemetry } from "./telemetry/types.ts";

const PREFERRED_STRICT_SAMPLING = {
	type: "json_schema",
	strict: "prefer",
} satisfies ConstrainedSamplingConfig;

interface RegisterToolOptions<TParams extends TSchema, TDetails, TState> {
	tool: RepairableToolDefinition<TParams, TDetails, TState>;
	telemetry?: ToolTelemetry<ToolArguments<TParams>, TDetails>;
	repair?: RepairSpecHints;
}

export type ToolTelemetrySink = Pick<TelemetryService, "registerTool" | "prepared">;

/** 装配时绑定遥测，注册与参数准备不再经过事件总线。 */
export function createToolRegistrar(pi: Pick<ExtensionAPI, "registerTool">, telemetry?: ToolTelemetrySink) {
	return function registerTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
		options: RegisterToolOptions<TParams, TDetails, TState>,
	): void {
		const prepared = repairableTool({
			...options.tool,
			constrainedSampling: options.tool.constrainedSampling ?? PREFERRED_STRICT_SAMPLING,
		}, options.repair, telemetry === undefined ? undefined : {
			onPreparation: (observation) => telemetry.prepared(observation),
		});
		telemetry?.registerTool(eraseRegistration<TParams, TDetails, TState>(prepared, options.telemetry));
		pi.registerTool(prepared);
	};
}

function eraseRegistration<TParams extends TSchema, TDetails, TState>(
	tool: ToolDefinition<TParams, TDetails, TState>,
	telemetry: ToolTelemetry<ToolArguments<TParams>, TDetails> | undefined,
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
			input: (params: unknown) => input(params as ToolArguments<TParams>),
		}),
		...(result === undefined ? {} : {
			result: (params: unknown, details: unknown) => result(
				params as ToolArguments<TParams>,
				details as TDetails,
			),
		}),
	};
}
