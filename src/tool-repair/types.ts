import type { TSchema } from "typebox";

export type RepairPath = string;

export interface ObjectArrayFromFieldsSpec {
	arrayField: string;
	fields: readonly string[];
}

export interface RepairSpecHints {
	singleStringField?: string;
	pathFields?: readonly RepairPath[];
	aliases?: Readonly<Record<string, string>>;
	nestedAliases?: Readonly<Record<RepairPath, string>>;
	objectToArrayFields?: readonly RepairPath[];
	objectArrayFromFields?: readonly ObjectArrayFromFieldsSpec[];
	dropOptionalNull?: boolean;
}

export interface RepairSpec extends RepairSpecHints {
	optionalFields: readonly RepairPath[];
	numericFields: readonly RepairPath[];
	arrayFields: readonly RepairPath[];
	objectToArrayFields: readonly RepairPath[];
	schema: TSchema;
}

