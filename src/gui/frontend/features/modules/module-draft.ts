import { parse, type ParseError } from "jsonc-parser";
import { mergeConfigValues } from "../../../../harness/config-values.ts";

export function readModuleConfig(text: string): Record<string, unknown> {
	const errors: ParseError[] = [];
	const value: unknown = parse(text.replace(/^\uFEFF/, "") || "{}", errors, { allowTrailingComma: true });
	if (errors.length || typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("JSONC 必须是有效对象。");
	return value as Record<string, unknown>;
}

export function parseModuleDraft(text: string, defaults: Record<string, unknown>) {
	let overrides: Record<string, unknown>;
	try { overrides = readModuleConfig(text); }
	catch (error) {
		return { overrides: undefined, value: undefined, error: error instanceof Error ? error.message : String(error) };
	}
	return { overrides, value: mergeConfigValues(defaults, overrides), error: "" };
}
