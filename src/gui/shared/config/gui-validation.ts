import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import schema from "../../../../agent/schemas/gui.schema.json" with { type: "json" };
import { Errors } from "typebox/value";
import { mergeConfigValues } from "../../../harness/config-values.ts";
import type { GuiPreferences } from "./preferences.ts";

export function parseGuiPreferences(content: string, defaults: GuiPreferences): GuiPreferences {
	const errors: ParseError[] = [];
	const value: unknown = parse(content.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
	const first = errors[0];
	if (first) throw new Error(`gui.jsonc: ${printParseErrorCode(first.error)} (offset ${first.offset})`);
	const issues = Errors(schema, value);
	if (issues.length) throw new Error(`gui.jsonc: ${issues.map((issue) => `${issue.instancePath || "/"}: ${issue.message}`).join("\n")}`);
	const { $schema: _schema, ...merged } = mergeConfigValues(defaults, value) as GuiPreferences & { $schema?: string };
	return merged;
}
