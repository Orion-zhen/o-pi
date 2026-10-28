import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isNotFound } from "../config-loader.ts";
import { modelsConfigSchema, type ModelsConfig } from "./schema.ts";
import { parseModelsDocument } from "./document.ts";
import { modelsConfigIssues } from "./validation.ts";

function invalidModelsConfig(path: string, reason: string): Error {
	return new Error(`Invalid ${path}:\n${reason}`);
}

export function defaultModelsPath(): string {
	return path.join(getAgentDir(), "models.json");
}

/** 沿用 SDK 原生 schema，并校验扩展字段。 */
export async function loadModelsConfig(configPath: string): Promise<ModelsConfig | undefined> {
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw invalidModelsConfig(configPath, "file cannot be read");
	}
	return parseModelsConfig(text, configPath);
}

export function parseModelsConfig(text: string, configPath: string): ModelsConfig {
	let source;
	try { source = parseModelsDocument(text); }
	catch (error) { throw invalidModelsConfig(configPath, error instanceof Error ? error.message : String(error)); }
	const issues = modelsConfigIssues(source, modelsConfigSchema);
	if (issues.length) throw invalidModelsConfig(configPath, issues.join("\n"));
	return source as ModelsConfig;
}

export async function ensure_private_config_permissions(configPath: string): Promise<string | undefined> {
	if (process.platform === "win32") return undefined;
	let info;
	try {
		info = await stat(configPath);
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
	if ((info.mode & 0o077) === 0) return undefined;
	return `Warning: ${configPath} may contain API keys and is readable or writable by group/others. Run: chmod 600 ${configPath}`;
}
