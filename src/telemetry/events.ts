import type { RepairObservation, RepairOperation, RepairSeparator, ToolArgumentStatus } from "../tool-repair/types.js";
import type { TelemetryFacts } from "./types.js";

export const TELEMETRY_READY_CHANNEL = "o-pi.telemetry.ready";
export const TELEMETRY_TOOL_CHANNEL = "o-pi.telemetry.tool";
export const TELEMETRY_REPAIR_CHANNEL = "o-pi.telemetry.repair";

const REPAIR_STATUSES: readonly string[] = ["accepted", "repaired", "invalid"];
const REPAIR_OPERATIONS: readonly string[] = [
	"original_prepare",
	"single_string_to_object",
	"root_alias",
	"object_array_from_fields",
	"json_string_to_array",
	"object_to_array",
	"nested_alias",
	"drop_optional_null",
	"numeric_string_to_number",
	"strip_path_prefix",
	"scalar_to_array",
	"split_path_list",
	"drop_unknown_field",
	"empty_value_to_default",
];
const REPAIR_SEPARATORS: readonly string[] = ["scalar", "comma", "whitespace", "newline", "mixed"];

export interface TelemetryToolDefinition {
	name: string;
	description: string;
	parameters: unknown;
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export interface TelemetryToolRegistration {
	definition: TelemetryToolDefinition;
	input?: (params: unknown) => TelemetryFacts;
	result?: (params: unknown, details: unknown) => TelemetryFacts;
}

export function telemetryToolRegistration(value: unknown): TelemetryToolRegistration {
	if (!isTelemetryToolRegistration(value)) throw new Error("Invalid telemetry tool registration");
	return value;
}

export function repairObservation(value: unknown): RepairObservation {
	if (!isRepairObservation(value)) throw new Error("Invalid telemetry repair observation");
	return value;
}

function isTelemetryToolRegistration(value: unknown): value is TelemetryToolRegistration {
	return isRecord(value) && isToolDefinition(value["definition"])
		&& (value["input"] === undefined || typeof value["input"] === "function")
		&& (value["result"] === undefined || typeof value["result"] === "function");
}

function isToolDefinition(value: unknown): value is TelemetryToolDefinition {
	return isRecord(value) && typeof value["name"] === "string" && typeof value["description"] === "string"
		&& value["parameters"] !== undefined
		&& (value["promptSnippet"] === undefined || typeof value["promptSnippet"] === "string")
		&& (value["promptGuidelines"] === undefined
			|| (Array.isArray(value["promptGuidelines"]) && value["promptGuidelines"].every((item) => typeof item === "string")));
}

function isRepairObservation(value: unknown): value is RepairObservation {
	return isRecord(value) && typeof value["toolName"] === "string" && isRepairStatus(value["status"])
		&& Array.isArray(value["operations"]) && value["operations"].every(isRepairOperation)
		&& (value["fanout"] === undefined || isRepairFanout(value["fanout"]));
}

function isRepairFanout(value: unknown): value is NonNullable<RepairObservation["fanout"]> {
	return isRecord(value) && typeof value["field"] === "string"
		&& typeof value["count"] === "number" && Number.isInteger(value["count"]) && value["count"] > 0
		&& isRepairSeparator(value["separator"]);
}

function isRepairStatus(value: unknown): value is ToolArgumentStatus {
	return typeof value === "string" && REPAIR_STATUSES.includes(value);
}

function isRepairOperation(value: unknown): value is RepairOperation {
	return typeof value === "string" && REPAIR_OPERATIONS.includes(value);
}

function isRepairSeparator(value: unknown): value is RepairSeparator {
	return typeof value === "string" && REPAIR_SEPARATORS.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
