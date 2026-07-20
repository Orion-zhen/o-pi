import { createHash } from "node:crypto";

import type { Candidate, Fields, FieldValue, Resource, TelemetryFacts, ToolTelemetry } from "./types.js";

const MAX_FIELDS = 48;
const MAX_FIELD_STRING_CHARS = 256;
const MAX_FIELD_ARRAY_ITEMS = 24;
const MAX_RESOURCES = 64;
const MAX_RESOURCE_VALUE_CHARS = 512;
const MAX_SOURCES = 12;

export interface SafeFacts {
	facts: TelemetryFacts;
	error?: string;
	limited: boolean;
}

export function defineToolTelemetry<TParams, TDetails>(
	telemetry: ToolTelemetry<TParams, TDetails>,
): ToolTelemetry<TParams, TDetails> {
	return telemetry;
}

export function fields(values: Record<string, FieldValue | undefined>): Fields {
	const result: Fields = {};
	for (const key of Object.keys(values)) {
		const value = values[key];
		if (value !== undefined) result[key] = value;
	}
	return result;
}

export function scalar(value: unknown): Exclude<FieldValue, string[]> | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function textFields(prefix: string, value: unknown): Fields {
	if (typeof value !== "string") return {};
	return {
		[`${prefix}_chars`]: value.length,
		[`${prefix}_lines`]: lineCount(value),
	};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stableHash(value: unknown): string {
	return sha256(canonicalJson(value));
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	if (typeof value === "number" && !Number.isFinite(value)) return "null";
	return JSON.stringify(value) ?? "null";
}

export function safeProject(projector: (() => unknown) | undefined): SafeFacts {
	if (projector === undefined) return { facts: {}, limited: false };
	try {
		const value = projector();
		if (isThenable(value)) return { facts: {}, error: "async_projection", limited: false };
		return boundFacts(value);
	} catch (error) {
		return { facts: {}, error: error instanceof Error ? error.name : "unknown", limited: false };
	}
}

export function mergeFacts(...values: readonly TelemetryFacts[]): TelemetryFacts {
	const mergedFields: Fields = {};
	const targets: Resource[] = [];
	const candidates: Candidate[] = [];
	for (const value of values) {
		Object.assign(mergedFields, value.fields);
		if (value.targets !== undefined) targets.push(...value.targets);
		if (value.candidates !== undefined) candidates.push(...value.candidates);
	}
	return {
		...(Object.keys(mergedFields).length === 0 ? {} : { fields: mergedFields }),
		...(targets.length === 0 ? {} : { targets }),
		...(candidates.length === 0 ? {} : { candidates }),
	};
}

function boundFacts(value: unknown): SafeFacts {
	if (!isRecord(value)) return { facts: {}, error: "invalid_projection", limited: false };
	const boundedFields = boundFields(value["fields"]);
	const targets = boundArray(value["targets"], resource, resourceLimited);
	const candidates = boundArray(value["candidates"], candidate, candidateLimited);
	return {
		facts: {
			...(Object.keys(boundedFields.value).length === 0 ? {} : { fields: boundedFields.value }),
			...(targets.value.length === 0 ? {} : { targets: targets.value }),
			...(candidates.value.length === 0 ? {} : { candidates: candidates.value }),
		},
		...(boundedFields.invalid || targets.invalid || candidates.invalid ? { error: "invalid_projection" } : {}),
		limited: boundedFields.limited || targets.limited || candidates.limited,
	};
}

function boundFields(value: unknown): { value: Fields; invalid: boolean; limited: boolean } {
	if (value === undefined) return { value: {}, invalid: false, limited: false };
	if (!isRecord(value)) return { value: {}, invalid: true, limited: false };
	const entries = Object.entries(value);
	const result: Fields = {};
	let invalid = false;
	let limited = entries.length > MAX_FIELDS;
	for (const [rawKey, rawValue] of entries.slice(0, MAX_FIELDS)) {
		const key = label(rawKey);
		limited ||= key !== rawKey;
		if (typeof rawValue === "string" && rawValue.length > MAX_FIELD_STRING_CHARS) {
			Object.assign(result, textFields(key, rawValue), { [`${key}_sha256`]: sha256(rawValue) });
			limited = true;
		} else if (rawValue === null || typeof rawValue === "string" || typeof rawValue === "boolean") {
			result[key] = rawValue;
		} else if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
			result[key] = rawValue;
		} else if (Array.isArray(rawValue)) {
			const strings = rawValue.filter((item): item is string => typeof item === "string");
			invalid ||= strings.length !== rawValue.length;
			limited ||= strings.length > MAX_FIELD_ARRAY_ITEMS || strings.some((item) => item.length > MAX_FIELD_STRING_CHARS);
			result[key] = strings.slice(0, MAX_FIELD_ARRAY_ITEMS).map((item) => item.length <= MAX_FIELD_STRING_CHARS ? item : `sha256:${sha256(item)}`);
		} else {
			invalid = true;
		}
	}
	return { value: result, invalid, limited };
}

function boundArray<T>(
	value: unknown,
	project: (value: unknown) => T | undefined,
	isLimited: (value: unknown) => boolean,
): { value: T[]; invalid: boolean; limited: boolean } {
	if (value === undefined) return { value: [], invalid: false, limited: false };
	if (!Array.isArray(value)) return { value: [], invalid: true, limited: false };
	const projected = value.slice(0, MAX_RESOURCES).map(project);
	return {
		value: projected.filter((item): item is T => item !== undefined),
		invalid: projected.some((item) => item === undefined),
		limited: value.length > MAX_RESOURCES || value.slice(0, MAX_RESOURCES).some(isLimited),
	};
}

function resource(value: unknown): Resource | undefined {
	if (!isRecord(value) || typeof value["kind"] !== "string" || typeof value["value"] !== "string") return undefined;
	return {
		kind: label(value["kind"]),
		value: resourceValue(value["value"]),
		...optionalLine("start_line", value),
		...optionalLine("end_line", value),
	};
}

function candidate(value: unknown): Candidate | undefined {
	const base = resource(value);
	if (base === undefined || !isRecord(value) || !positiveInteger(value["rank"])
		|| !Array.isArray(value["sources"]) || !value["sources"].every((item) => typeof item === "string")) return undefined;
	const sources = value["sources"].slice(0, MAX_SOURCES).map(label);
	return {
		...base,
		rank: value["rank"],
		...(typeof value["group"] === "string" ? { group: label(value["group"]) } : {}),
		sources: [...new Set(sources)].sort(),
	};
}

function resourceLimited(value: unknown): boolean {
	return isRecord(value) && ((typeof value["kind"] === "string" && value["kind"].length > 128)
		|| (typeof value["value"] === "string" && value["value"].length > MAX_RESOURCE_VALUE_CHARS));
}

function candidateLimited(value: unknown): boolean {
	return resourceLimited(value) || (isRecord(value) && Array.isArray(value["sources"])
		&& (value["sources"].length > MAX_SOURCES || value["sources"].some((item) => typeof item === "string" && item.length > 128)));
}

function optionalLine(key: "start_line" | "end_line", value: Record<string, unknown>): Partial<Resource> {
	const input = value[key];
	return positiveInteger(input) ? { [key]: input } : {};
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function resourceValue(value: string): string {
	return value.length <= MAX_RESOURCE_VALUE_CHARS ? value : `sha256:${sha256(value)}`;
}

function label(value: string): string {
	return value.length <= 128 ? value : `sha256:${sha256(value)}`;
}

function lineCount(value: string): number {
	if (value.length === 0) return 0;
	let lines = 1;
	for (let index = 0; index < value.length; index += 1) {
		if (value.charCodeAt(index) === 10) lines += 1;
	}
	return lines;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (typeof value === "object" && value !== null) || typeof value === "function"
		? typeof Reflect.get(value, "then") === "function"
		: false;
}
