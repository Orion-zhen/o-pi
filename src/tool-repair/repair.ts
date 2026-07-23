import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createRepairSpec } from "./specs.js";
import type { RepairObserver, RepairOperation, RepairSpec, RepairSpecHints, ToolArgumentStatus } from "./types.js";

export const DEFAULT_MAX_PATH_COUNT = 32;

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
	observer?: RepairObserver,
): ToolDefinition<TParams, TDetails, TState> {
	const originalPrepareArguments = tool.prepareArguments;
	const spec = createRepairSpec(tool.parameters, hints);
	const prepareArguments: ToolDefinition<TParams, TDetails, TState>["prepareArguments"] = (args) => {
		const operations: RepairOperation[] = [];
		const rawWasValid = isValid(tool.parameters, args);
		const rawJson = structuralJson(args);
		let prepared: unknown;
		try {
			prepared = originalPrepareArguments ? originalPrepareArguments(args) : args;
		} catch (error) {
			notify(observer, tool.name, args, args, "invalid", operations);
			throw error;
		}
		if (originalPrepareArguments !== undefined && !matchesStructuralJson(rawJson, args, prepared)) operations.push("original_prepare");
		if (isValid(tool.parameters, prepared)) {
			const status: ToolArgumentStatus = rawWasValid ? "accepted" : "repaired";
			notify(observer, tool.name, args, prepared, status, operations);
			return prepared as PreparedArguments<TParams, TDetails, TState>;
		}

		const repaired = repairArguments(prepared, spec, operations);
		if (isValid(tool.parameters, repaired)) {
			notify(observer, tool.name, args, repaired, "repaired", operations);
			return repaired as PreparedArguments<TParams, TDetails, TState>;
		}

		notify(observer, tool.name, args, prepared, "invalid", operations);
		return prepared as PreparedArguments<TParams, TDetails, TState>;
	};
	return {
		...tool,
		prepareArguments,
	};
}

function notify(
	observer: RepairObserver | undefined,
	toolName: string,
	rawArgs: unknown,
	preparedArgs: unknown,
	status: ToolArgumentStatus,
	operations: readonly RepairOperation[],
): void {
	try {
		observer?.onPreparation({ toolName, rawArgs, preparedArgs, status, operations });
	} catch {
		// Observers are diagnostic only and cannot affect argument preparation.
	}
}

export function repairArguments(args: unknown, spec: RepairSpec, operations: RepairOperation[] = []): unknown {
	let candidate = cloneValue(args);

	if (typeof candidate === "string" && spec.singleStringField !== undefined) {
		candidate = { [spec.singleStringField]: candidate };
		operations.push("single_string_to_object");
	}
	if (!isPlainObject(candidate)) return candidate;

	migrateRootAliases(candidate, spec, operations);
	materializeObjectArrays(candidate, spec, operations);
	repairArrayFields(candidate, spec, operations);
	repairPathListFields(candidate, spec, operations);
	migrateNestedAliases(candidate, spec, operations);
	dropOptionalNullFields(candidate, spec, operations);
	repairNumericFields(candidate, spec, operations);
	repairPathFields(candidate, spec, operations);
	cleanUnknownFields(spec.schema, candidate, operations);

	return candidate;
}

export function isValid<T extends TSchema>(schema: T, value: unknown): boolean {
	return Check(schema, value);
}

function migrateRootAliases(target: JsonObject, spec: RepairSpec, operations: RepairOperation[]): void {
	for (const [sourceKey, targetKey] of Object.entries(spec.aliases ?? {})) {
		if (!Object.hasOwn(target, sourceKey) || Object.hasOwn(target, targetKey)) continue;
		target[targetKey] = target[sourceKey];
		delete target[sourceKey];
		operations.push("root_alias");
	}
}

function migrateNestedAliases(target: JsonObject, spec: RepairSpec, operations: RepairOperation[]): void {
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
			operations.push("nested_alias");
		});
	}
}

function materializeObjectArrays(target: JsonObject, spec: RepairSpec, operations: RepairOperation[]): void {
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
		operations.push("object_array_from_fields");
	}
}

function repairArrayFields(target: JsonObject, spec: RepairSpec, operations: RepairOperation[]): void {
	const objectToArrayFields = new Set(spec.objectToArrayFields);
	for (const path of spec.arrayFields) {
		forEachParentAtPath(target, splitPath(path), (parent, key) => {
			const value = parent[key];
			if (typeof value === "string") {
				const parsed = parseJsonArray(value);
				if (parsed !== undefined) {
					parent[key] = parsed;
					operations.push("json_string_to_array");
				}
				return;
			}
			if (objectToArrayFields.has(path) && isPlainObject(value)) {
				parent[key] = [value];
				operations.push("object_to_array");
			}
		});
	}
}

function dropOptionalNullFields(target: JsonObject, spec: RepairSpec, operations: RepairOperation[]): void {
	if (spec.dropOptionalNull !== true) return;
	for (const path of spec.optionalFields) {
		forEachParentAtPath(target, splitPath(path), (parent, key) => {
			if (parent[key] === null) {
				delete parent[key];
				operations.push("drop_optional_null");
			}
		});
	}
}

function repairNumericFields(target: JsonObject, spec: RepairSpec, operations: RepairOperation[]): void {
	for (const path of spec.numericFields) {
		forEachParentAtPath(target, splitPath(path), (parent, key) => {
			const value = parent[key];
			if (typeof value !== "string" || !isPlainNumericString(value)) return;
			parent[key] = Number(value);
			operations.push("numeric_string_to_number");
		});
	}
}

function repairPathListFields(target: JsonObject, spec: RepairSpec, operations: RepairOperation[]): void {
	const pathListFields = new Set(spec.pathListFields ?? []);
	const maxPathCount = normalizeMaxPathCount(spec.maxPathCount);
	for (const path of pathListFields) {
		forEachParentAtPath(target, splitPath(path), (parent, key) => {
			const value = parent[key];
			if (typeof value !== "string") return;
			const paths = parsePathList(value, maxPathCount);
			if (paths === undefined) return;
			parent[key] = unique(paths);
			operations.push(paths.length > 1 ? "split_path_list" : "scalar_to_array");
		});
	}
}

function repairPathFields(target: JsonObject, spec: RepairSpec, operations: RepairOperation[]): void {
	const pathListFields = new Set(spec.pathListFields ?? []);
	for (const path of spec.pathFields ?? []) {
		forEachParentAtPath(target, splitPath(path), (parent, key) => {
			const value = parent[key];
			if (typeof value === "string" && pathListFields.has(path)) return;
			if (typeof value === "string" && value.startsWith("@") && value.length > 1) {
				parent[key] = value.slice(1);
				operations.push("strip_path_prefix");
				return;
			}
			if (!pathListFields.has(path) || !Array.isArray(value) || !value.every(isString)) return;
			const normalized = value.map((item) => item.startsWith("@") && item.length > 1 ? item.slice(1) : item);
			const uniquePaths = unique(normalized);
			if (normalized.some((item, index) => item !== value[index])) operations.push("strip_path_prefix");
			parent[key] = uniquePaths;
		});
	}
}

function cleanUnknownFields(schema: TSchema, value: unknown, operations: RepairOperation[]): void {
	const node = schema as SchemaNode;
	if (node.type === "array" && Array.isArray(value) && node.items !== undefined) {
		for (const item of value) cleanUnknownFields(node.items, item, operations);
		return;
	}
	if (node.type !== "object" || node.properties === undefined || !isPlainObject(value)) return;
	if (!requiredFieldsPresent(node, value)) return;

	for (const [key, childSchema] of Object.entries(node.properties)) {
		cleanUnknownFields(childSchema, value[key], operations);
	}
	if (node.additionalProperties !== false) return;
	for (const key of Object.keys(value)) {
		if (!Object.hasOwn(node.properties, key)) {
			delete value[key];
			operations.push("drop_unknown_field");
		}
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

function structuralJson(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

function matchesStructuralJson(rawJson: string | undefined, raw: unknown, prepared: unknown): boolean {
	return rawJson === undefined ? raw === prepared : rawJson === structuralJson(prepared);
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

/** Parse the conservative path-list syntax used only by configured path fields. */
export function parsePathList(value: string, maxPathCount = DEFAULT_MAX_PATH_COUNT): string[] | undefined {
	const limit = normalizeMaxPathCount(maxPathCount);
	const paths: string[] = [];
	let token = "";
	let tokenStarted = false;
	let quote: "\"" | "'" | undefined;
	let escaped = false;
	let afterComma = false;

	const pushToken = (): boolean => {
		if (!tokenStarted || token.length === 0) return false;
		if (paths.length >= limit) return false;
		paths.push(token);
		token = "";
		tokenStarted = false;
		return true;
	};

	for (const character of value) {
		if (quote !== undefined) {
			if (escaped) {
				token += character === quote || character === "\\" ? character : `\\${character}`;
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === quote) {
				quote = undefined;
				continue;
			}
			token += character;
			tokenStarted = true;
			continue;
		}
		if (character === "\"" || character === "'") {
			quote = character;
			tokenStarted = true;
			afterComma = false;
			continue;
		}
		if (character === ",") {
			if (tokenStarted && !pushToken()) return undefined;
			if (afterComma) return undefined;
			afterComma = true;
			continue;
		}
		if (/\s/u.test(character)) {
			if (tokenStarted && !pushToken()) return undefined;
			continue;
		}
		token += character;
		tokenStarted = true;
		afterComma = false;
	}
	if (quote !== undefined || escaped || (tokenStarted && !pushToken()) || afterComma || paths.length === 0) return undefined;
	return paths;
}

function normalizeMaxPathCount(value: number | undefined): number {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_PATH_COUNT;
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}
