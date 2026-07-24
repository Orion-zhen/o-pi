import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import { repairableTool } from "../tool-repair/repair.js";
import type { RepairSpecHints } from "../tool-repair/types.js";
import { telemetryServiceFor } from "./service.js";
import type { ToolTelemetry } from "./types.js";

type ExecutedParams<TParams extends TSchema, TDetails, TState> = Parameters<ToolDefinition<TParams, TDetails, TState>["execute"]>[1];
type ObservedPi = Pick<ExtensionAPI, "events" | "getAllTools" | "getThinkingLevel" | "on" | "registerTool">;

export interface ObservedToolOptions<TParams extends TSchema, TDetails, TState> {
	tool: ToolDefinition<TParams, TDetails, TState>;
	telemetry?: ToolTelemetry<ExecutedParams<TParams, TDetails, TState>, TDetails>;
	repair?: RepairSpecHints;
}

/** Register a tool and its small, payload-free telemetry projection. */
export function registerObservedTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
	pi: ObservedPi,
	options: ObservedToolOptions<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
	let service: ReturnType<typeof telemetryServiceFor> | undefined;
	const prepared = repairableTool(options.tool, options.repair, {
		onPreparation(observation) {
			try { service?.prepared(observation); } catch {}
		},
	});
	pi.registerTool(prepared);
	try {
		service = telemetryServiceFor(pi);
		service.registerTool(prepared, options.telemetry);
	} catch {
		// Instrumentation cannot change registration.
	}
	return prepared;
}

export { defineToolTelemetry } from "./projection.js";
