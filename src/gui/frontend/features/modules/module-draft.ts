import { parse, type ParseError } from "jsonc-parser";
import type { Validator } from "@earendil-works/pi-schema";
import { mergeConfigValues } from "../../../../harness/config-values.ts";

export function readModuleConfig(text: string): Record<string, unknown> {
	const errors: ParseError[] = [];
	const value: unknown = parse(text.replace(/^\uFEFF/, "") || "{}", errors, { allowTrailingComma: true });
	if (errors.length || typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("JSONC 必须是有效对象。");
	return value as Record<string, unknown>;
}

export function configAt(value: unknown, path: string): unknown {
	for (const key of path.split(".")) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

export function parseModuleDraft(text: string, defaults: Record<string, unknown>, validator: Validator) {
	try {
		const overrides = readModuleConfig(text);
		const error = validator.check(overrides) ? "" : `配置不符合 schema: ${JSON.stringify(validator.errors(overrides))}`;
		return { state: "parsed" as const, overrides, value: mergeConfigValues(defaults, overrides), error };
	} catch (error) {
		return { state: "invalid" as const, overrides: undefined, value: undefined, error: error instanceof Error ? error.message : String(error) };
	}
}
