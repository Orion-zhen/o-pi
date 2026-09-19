import path from "node:path";
import { readFile } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import {
	CONFIG_DEFINITIONS, agentSchemaPath, createSchemaValidator, defaultAgentConfigPath,
	isNotFound, mergeConfigValues, readDefaultJsoncConfigSync, stripUtf8Bom,
} from "../../harness/config-loader.ts";
import type { GuiConfigDocument, GuiPreferences } from "../preferences.ts";
import { replaceConfigFile } from "./files.ts";

const definition = CONFIG_DEFINITIONS.gui;
const schemaPath = agentSchemaPath("gui.schema.json");
const createError = (message: string, details?: Record<string, unknown>) => new Error(`${message}${details ? ` ${JSON.stringify(details)}` : ""}`);
const validator = createSchemaValidator({ schemaPath, label: "gui", createError });

function configPath(): string {
	return process.env[definition.userEnv] ?? path.join(getAgentDir(), "configs", definition.fileName);
}

export function readGuiDefaults(): GuiPreferences {
	const { $schema: _schema, ...value } = readDefaultJsoncConfigSync({
		configPath: defaultAgentConfigPath(definition.fileName), schemaPath, label: "gui", createError,
	}) as GuiPreferences & { $schema?: string };
	return value;
}

async function parsePreferences(content: string, base: GuiPreferences): Promise<GuiPreferences> {
	const errors: ParseError[] = [];
	const value: unknown = parse(stripUtf8Bom(content), errors, { allowTrailingComma: true });
	const first = errors[0];
	if (first) throw new Error(`gui.jsonc: ${printParseErrorCode(first.error)} (offset ${first.offset})`);
	const validate = await validator();
	if (!validate(value)) throw new Error(`gui.jsonc: ${JSON.stringify(validate.errors)}`);
	const { $schema: _schema, ...merged } = mergeConfigValues(base, value) as GuiPreferences & { $schema?: string };
	return merged;
}

/** 原文和生效值来自同一次读取，非法用户配置仍可在界面中修复。 */
export async function readGuiConfig(): Promise<GuiConfigDocument> {
	const target = configPath();
	const base = readGuiDefaults();
	let content: string;
	try { content = await readFile(target, "utf8"); }
	catch (error) {
		if (!isNotFound(error)) throw error;
		return { path: target, content: "", defaults: base, state: "ready", value: base };
	}
	const document = { path: target, content, defaults: base };
	try { return { ...document, state: "ready", value: await parsePreferences(content, base) }; }
	catch (error) { return { ...document, state: "error", message: error instanceof Error ? error.message : String(error) }; }
}

export async function saveGuiConfig(original: string, content: string): Promise<GuiConfigDocument> {
	await parsePreferences(content, readGuiDefaults());
	await replaceConfigFile(configPath(), original, content);
	return readGuiConfig();
}
