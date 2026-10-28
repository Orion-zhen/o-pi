import path from "node:path";
import { readFile } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DEFINITIONS, isNotFound, readDefaultJsoncConfigSync,
} from "../../../harness/config-loader.ts";
import { parseGuiPreferences } from "../../shared/config/gui-validation.ts";
import type { GuiConfigDocument, GuiPreferences } from "../../shared/config/preferences.ts";
import { replaceConfigFile } from "../session/files.ts";

const definition = CONFIG_DEFINITIONS.gui;

function configPath(): string {
	return process.env[definition.userEnv] ?? path.join(getAgentDir(), "configs", definition.fileName);
}

export function readGuiDefaults(): GuiPreferences {
	const { $schema: _schema, ...value } = readDefaultJsoncConfigSync<GuiPreferences & { $schema?: string }>(definition);
	return value;
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
	try { return { ...document, state: "ready", value: parseGuiPreferences(content, base) }; }
	catch (error) { return { ...document, state: "error", message: error instanceof Error ? error.message : String(error) }; }
}

export async function saveGuiConfig(original: string, content: string): Promise<GuiConfigDocument> {
	parseGuiPreferences(content, readGuiDefaults());
	await replaceConfigFile(configPath(), original, content);
	return readGuiConfig();
}
