import type { TSchema } from "typebox";

export type RepairPath = string;

export type ToolArgumentStatus = "accepted" | "repaired" | "invalid";
export type RepairSeparator = "scalar" | "comma" | "whitespace" | "newline" | "mixed";

export interface RepairFanout {
	field: string;
	count: number;
	separator: RepairSeparator;
}

export type RepairOperation =
	| "single_string_to_object"
	| "root_alias"
	| "object_array_from_fields"
	| "json_string_to_array"
	| "object_to_array"
	| "nested_alias"
	| "drop_optional_null"
	| "numeric_string_to_number"
	| "strip_path_prefix"
	| "scalar_to_array"
	| "split_path_list"
	| "drop_unknown_field";

export interface RepairObservation {
	toolName: string;
	rawArgs: unknown;
	preparedArgs: unknown;
	status: ToolArgumentStatus;
	operations: readonly RepairOperation[];
	fanout?: RepairFanout;
}

export interface RepairObserver {
	onPreparation(observation: RepairObservation): void;
}

export interface ObjectArrayFromFieldsSpec {
	arrayField: string;
	fields: readonly string[];
}

export interface RepairSpecHints {
	singleStringField?: string;
	pathFields?: readonly RepairPath[];
	pathListFields?: readonly RepairPath[];
	aliases?: Readonly<Record<string, string>>;
	nestedAliases?: Readonly<Record<RepairPath, string>>;
	objectArrayFromFields?: readonly ObjectArrayFromFieldsSpec[];
}

export interface RepairSpec extends Required<Omit<RepairSpecHints, "singleStringField">> {
	singleStringField?: string;
	optionalFields: readonly RepairPath[];
	numericFields: readonly RepairPath[];
	arrayFields: readonly RepairPath[];
	objectToArrayFields: readonly RepairPath[];
	schema: TSchema;
}
