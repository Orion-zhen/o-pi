import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createRepairSpec } from "./specs.js";
import type { RepairSpec, RepairSpecHints } from "./types.js";

interface SchemaNode {
	type?: string;
	required?: readonly string[];
	properties?: Record<string, TSchema>;
	items?: TSchema;
	additionalProperties?: boolean | TSchema;
}

type JsonObject = Record<string, unknown>;

export function repairableTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
	tool: ToolDefinition<TParams, TDetails, TState>,
	hints: RepairSpecHints = {},
): ToolDefinition<TParams, TDetails, TState> {
	const originalPrepareArguments = tool.prepareArguments;
	const spec = createRepairSpec(tool.parameters, hints);
	const prepareArguments: ToolDefinition<TParams, TDetails, TState>["prepareArguments"] = (args) => {
		const prepared = originalPrepareArguments ? originalPrepareArguments(args) : args;
		if (isValid(tool.parameters, prepared)) return prepared as PreparedArguments<TParams, TDetails, TState>;

		const repaired = repairArguments(prepared, spec);
		if (isValid(tool.parameters, repaired)) return repaired as PreparedArguments<TParams, TDetails, TState>;

		return prepared as PreparedArguments<TParams, TDetails, TState>;
	};
	return {
		...tool,
		prepareArguments,
	};
}

export function repairArguments(args: unknown, spec: RepairSpec): unknown {
	let candidate = cloneValue(args);

	if (typeof candidate === "string" && spec.singleStringField !== undefined) {
		candidate = { [spec.singleStringField]: candidate };
	}
	if (!isPlainObject(candidate)) return candidate;

	migrateRootAliases(candidate, spec);
	materializeObjectArrays(candidate, spec);
	repairArrayFields(candidate, spec);
	migrateNestedAliases(candidate, spec);
	dropOptionalNullFields(candidate, spec);
	repairNumericFields(candidate, spec);
	repairPathFields(candidate, spec);
	cleanUnknownFields(spec.schema, candidate);

	return candidate;
}

export function isValid<T extends TSchema>(schema: T, value: unknown): boolean {
	return Check(schema, value);
}

function migrateRootAliases(target: JsonObject, spec: RepairSpec): void {
	for (const [sourceKey, targetKey] of Object.entries(spec.aliases ?? {})) {
		if (!Object.hasOwn(target, sourceKey) || Object.hasOwn(target, targetKey)) continue;
		target[targetKey] = target[sourceKey];
		delete target[sourceKey];
	}
}

function migrateNestedAliases(target: JsonObject, spec: RepairSpec): void {
	for (const [sourcePath, targetKey] of Object.entries(spec.nestedAliases ?? {})) {
		const segments = splitPath(sourcePath);
		const sourceKey = segments.at(-1);
		if (sourceKey === undefined) continue;
		const parentPath = segments.slice(0, -1);
		const targetSchema = getSchemaAtPath(spec.schema, [...parentPath, targetKey]);
		forEachObjectAtPath(target, parentPath, (parent) => {
			if (!Object.hasOwn(parent, sourceKey) || Object.hasOwn(parent, targetKey)) return;
			const value = parent[sourceKey];
			if (targetSchema !== undefined && !Check(targetSchema, value)) return;
			parent[targetKey] = value;
			delete parent[sourceKey];
		});
	}
}

function materializeObjectArrays(target: JsonObject, spec: RepairSpec): void {
	for (const { arrayField, fields } of spec.objectArrayFromFields ?? []) {
		if (Object.hasOwn(target, arrayField)) continue;
		const entry: JsonObject = {};
		for (const field of fields) {
			if (!Object.hasOwn(target, field)) return;
			const value = target[field];
			if (typeof value !== "string") return;
			entry[field] = value;
		}
		target[arrayField] = [entry];
		for (const field of fields) delete target[field];
	}
}

function repairArrayFields(target: JsonObject, spec: RepairSpec): void {
	const objectToArrayFields = new Set(spec.objectToArrayFields);
	for (const path of spec.arrayFields) {
		forEachParentAtPath(target, splitPath(path), (parent, key) => {
			const value = parent[key];
			if (typeof value === "string") {
				const parsed = parseJsonArray(value);
				if (parsed !== undefined) parent[key] = parsed;
				return;
			}
			if (objectToArrayFields.has(path) && isPlainObject(value)) {
				parent[key] = [value];
			}
		});
	}
}

function dropOptionalNullFields(target: JsonObject, spec: RepairSpec): void {
	if (spec.dropOptionalNull !== true) return;
	for (const path of spec.optionalFields) {
		forEachParentAtPath(target, splitPath(path), (parent, key) => {
			if (parent[key] === null) delete parent[key];
		});
	}
}

function repairNumericFields(target: JsonObject, spec: RepairSpec): void {
	for (const path of spec.numericFields) {
		forEachParentAtPath(target, splitPath(path), (parent, key) => {
			const value = parent[key];
			if (typeof value !== "string" || !isPlainNumericString(value)) return;
			parent[key] = Number(value);
		});
	}
}

function repairPathFields(target: JsonObject, spec: RepairSpec): void {
	for (const path of spec.pathFields ?? []) {
		forEachParentAtPath(target, splitPath(path), (parent, key) => {
			const value = parent[key];
			if (typeof value === "string" && value.startsWith("@") && value.length > 1) {
				parent[key] = value.slice(1);
			}
		});
	}
}

function cleanUnknownFields(schema: TSchema, value: unknown): void {
	const node = schema as SchemaNode;
	if (node.type === "array" && Array.isArray(value) && node.items !== undefined) {
		for (const item of value) cleanUnknownFields(node.items, item);
		return;
	}
	if (node.type !== "object" || node.properties === undefined || !isPlainObject(value)) return;
	if (!requiredFieldsPresent(node, value)) return;

	for (const [key, childSchema] of Object.entries(node.properties)) {
		cleanUnknownFields(childSchema, value[key]);
	}
	if (node.additionalProperties !== false) return;
	for (const key of Object.keys(value)) {
		if (!Object.hasOwn(node.properties, key)) delete value[key];
	}
}

function requiredFieldsPresent(schema: SchemaNode, value: JsonObject): boolean {
	return (schema.required ?? []).every((key) => Object.hasOwn(value, key));
}

function getSchemaAtPath(schema: TSchema, segments: readonly string[]): TSchema | undefined {
	let current: TSchema | undefined = schema;
	for (const segment of segments) {
		if (current === undefined) return undefined;
		const node = current as SchemaNode;
		if (segment === "*") {
			current = node.type === "array" ? node.items : undefined;
			continue;
		}
		if (node.type === "array") {
			current = node.items;
			if (current === undefined) return undefined;
		}
		const objectNode = current as SchemaNode;
		current = objectNode.type === "object" ? objectNode.properties?.[segment] : undefined;
	}
	return current;
}

function forEachParentAtPath(value: unknown, segments: readonly string[], visit: (parent: JsonObject, key: string) => void): void {
	if (segments.length === 0) return;
	const key = segments.at(-1);
	if (key === undefined || key === "*") return;
	forEachObjectAtPath(value, segments.slice(0, -1), (parent) => visit(parent, key));
}

function forEachObjectAtPath(value: unknown, segments: readonly string[], visit: (value: JsonObject) => void): void {
	if (segments.length === 0) {
		if (isPlainObject(value)) visit(value);
		return;
	}
	const [head, ...tail] = segments;
	if (head === undefined) return;
	if (head === "*") {
		if (!Array.isArray(value)) return;
		for (const item of value) forEachObjectAtPath(item, tail, visit);
		return;
	}
	if (!isPlainObject(value)) return;
	forEachObjectAtPath(value[head], tail, visit);
}

function cloneValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => cloneValue(item));
	if (!isPlainObject(value)) return value;
	const result: JsonObject = {};
	for (const [key, child] of Object.entries(value)) result[key] = cloneValue(child);
	return result;
}

function isPlainObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonArray(value: string): unknown[] | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isPlainNumericString(value: string): boolean {
	return /^[+-]?(?:\d+|\d+\.\d+|\.\d+)$/.test(value);
}

type PreparedArguments<TParams extends TSchema, TDetails, TState> = ReturnType<
	NonNullable<ToolDefinition<TParams, TDetails, TState>["prepareArguments"]>
>;

function splitPath(path: string): string[] {
	return path.split(".").filter((segment) => segment.length > 0);
}
