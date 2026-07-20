import type { EventBus } from "@earendil-works/pi-coding-agent";

import {
	cloneTelemetryPayload,
	decodeTelemetryJsonObject,
	decodeToolObservation,
} from "./adapter.js";
import type {
	ApprovalTelemetry,
	ExecuteTelemetry,
	InputProjection,
	RepairOperation,
	ToolArgumentStatus,
	ToolObservation,
} from "./types.js";

export const TELEMETRY_RUNTIME_CHANNEL = "o-pi:telemetry-runtime";
export const TELEMETRY_RUNTIME_FAILURE_CHANNEL = "o-pi:telemetry-runtime-failure";
const emittedEvents = new WeakMap<object, TelemetryRuntimeEvent>();

export type TelemetryRuntimeEvent =
	| {
			kind: "preparation";
			tool_call_id: string;
			tool_name: string;
			status: ToolArgumentStatus;
			operations: RepairOperation[];
			projection_failed?: true;
			projection_limited?: true;
	  }
	| {
			kind: "execute_start";
			tool_call_id: string;
			tool_name: string;
			executed: InputProjection;
			projection_failed?: true;
			projection_limited?: true;
	  }
	| {
			kind: "execute_end";
			tool_call_id: string;
			tool_name: string;
			execute: ExecuteTelemetry;
			observation?: ToolObservation;
			projection_failed?: true;
			projection_limited?: true;
	  }
	| {
			kind: "approval";
			tool_call_id: string;
			tool_name: string;
			approval: ApprovalTelemetry;
	  };

export function emitTelemetryRuntime(events: EventBus, event: TelemetryRuntimeEvent): boolean {
	try {
		emittedEvents.set(event, event);
		events.emit(TELEMETRY_RUNTIME_CHANNEL, event);
		return true;
	} catch {
		try {
			events.emit(TELEMETRY_RUNTIME_FAILURE_CHANNEL, { tool_call_id: event.tool_call_id, tool_name: event.tool_name, kind: event.kind });
		} catch {
			// Final best-effort boundary.
		}
		return false;
	}
}

export function decodeTelemetryRuntimeEvent(value: unknown): TelemetryRuntimeEvent | undefined {
	try {
		if (typeof value === "object" && value !== null) {
			const emitted = emittedEvents.get(value);
			if (emitted !== undefined) return emitted;
		}
		const payload = cloneTelemetryPayload(value);
		if (!isRecord(payload)) return undefined;
		const toolCallId = string(payload["tool_call_id"]);
		const toolName = string(payload["tool_name"]);
		if (toolCallId === undefined || toolName === undefined) return undefined;
		switch (payload["kind"]) {
			case "preparation": {
				const status = argumentStatus(payload["status"]);
				const operations = repairOperations(payload["operations"]);
				if (status === undefined || operations === undefined) return undefined;
				return {
					kind: "preparation",
					tool_call_id: toolCallId,
					tool_name: toolName,
					status,
					operations,
					...(payload["projection_failed"] === true ? { projection_failed: true } : {}),
					...(payload["projection_limited"] === true ? { projection_limited: true } : {}),
				};
			}
			case "execute_start": {
				return {
					kind: "execute_start",
					tool_call_id: toolCallId,
					tool_name: toolName,
					executed: inputProjection(payload["executed"]),
					...(payload["projection_failed"] === true ? { projection_failed: true } : {}),
					...(payload["projection_limited"] === true ? { projection_limited: true } : {}),
				};
			}
			case "execute_end": {
				const execute = executeTelemetry(payload["execute"]);
				if (execute === undefined) return undefined;
				const observation = payload["observation"] === undefined
					? undefined
					: decodeToolObservation(payload["observation"]);
				return {
					kind: "execute_end",
					tool_call_id: toolCallId,
					tool_name: toolName,
					execute,
					...(observation === undefined ? {} : { observation }),
					...(payload["projection_failed"] === true ? { projection_failed: true } : {}),
					...(payload["projection_limited"] === true ? { projection_limited: true } : {}),
				};
			}
			case "approval": {
				const approval = approvalTelemetry(payload["approval"]);
				return approval === undefined ? undefined : {
					kind: "approval",
					tool_call_id: toolCallId,
					tool_name: toolName,
					approval,
				};
			}
			default:
				return undefined;
		}
	} catch {
		return undefined;
	}
}

function inputProjection(value: unknown): InputProjection {
	if (!isRecord(value)) throw new Error("Telemetry input projection must be an object");
	const observation = decodeToolObservation({ references: value["references"] });
	return {
		value: decodeTelemetryJsonObject(value["value"]),
		...(observation.references === undefined ? {} : { references: observation.references }),
	};
}

function executeTelemetry(value: unknown): ExecuteTelemetry | undefined {
	if (!isRecord(value)) return undefined;
	const duration = finiteNumber(value["duration_ms"]);
	if (duration === undefined || (value["state"] !== "returned" && value["state"] !== "threw") || typeof value["signal_aborted"] !== "boolean") {
		return undefined;
	}
	const errorName = string(value["error_name"]);
	return {
		duration_ms: duration,
		state: value["state"],
		signal_aborted: value["signal_aborted"],
		...(errorName === undefined ? {} : { error_name: errorName }),
	};
}

function repairOperation(value: unknown): RepairOperation | undefined {
	switch (value) {
		case "original_prepare":
		case "single_string_to_object":
		case "root_alias":
		case "object_array_from_fields":
		case "json_string_to_array":
		case "object_to_array":
		case "nested_alias":
		case "drop_optional_null":
		case "numeric_string_to_number":
		case "strip_path_prefix":
		case "drop_unknown_field":
			return value;
		default:
			return undefined;
	}
}

function repairOperations(value: unknown): RepairOperation[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const operations: RepairOperation[] = [];
	for (const item of value) {
		const repair = repairOperation(item);
		if (repair === undefined) return undefined;
		operations.push(repair);
	}
	return operations;
}

function argumentStatus(value: unknown): ToolArgumentStatus | undefined {
	return value === "accepted" || value === "repaired" || value === "invalid" ? value : undefined;
}

function approvalTelemetry(value: unknown): ApprovalTelemetry | undefined {
	if (!isRecord(value)) return undefined;
	const decision = approvalDecision(value["decision"]);
	const outcome = approvalOutcome(value["outcome"]);
	const wait = finiteNumber(value["wait_ms"]);
	if (decision === undefined || outcome === undefined || wait === undefined) return undefined;
	const ruleName = string(value["rule_name"]);
	return {
		decision,
		outcome,
		wait_ms: wait,
		...(ruleName === undefined ? {} : { rule_name: ruleName }),
	};
}

function approvalDecision(value: unknown): ApprovalTelemetry["decision"] | undefined {
	return value === "allow" || value === "deny" || value === "ask" ? value : undefined;
}

function approvalOutcome(value: unknown): ApprovalTelemetry["outcome"] | undefined {
	switch (value) {
		case "not_required":
		case "gate_disabled":
		case "policy_allow":
		case "policy_deny":
		case "safety_block":
		case "non_interactive_allow":
		case "non_interactive_block":
		case "allow_once":
		case "allow_session":
		case "allow_persistent":
		case "deny":
		case "deny_with_instruction":
		case "dismissed":
			return value;
		default:
			return undefined;
	}
}

function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
