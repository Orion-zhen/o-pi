import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

const USER_CONFIG_ENV = "PI_TOOLS_CONFIG";
const PROJECT_CONFIG_ENV = "PI_TOOLS_PROJECT_CONFIG";
const PROJECT_ROOT_ENV = "PI_TOOLS_PROJECT_ROOT";

export interface ToolDefaultsConfig {
	tools: Record<string, boolean>;
}

export class ToolDefaultsConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "ToolDefaultsConfigError";
	}
}

export async function loadToolDefaultsConfig(cwd = process.cwd()): Promise<ToolDefaultsConfig> {
	const userPath = userConfigPath();
	const userConfig = parseToolMap((await readOptionalConfig(userPath))?.value, userPath);

	const projectPath = projectConfigPath(cwd);
	const projectConfig = projectPath === undefined ? {} : parseToolMap((await readOptionalConfig(projectPath))?.value, projectPath);

	return { tools: { ...userConfig, ...projectConfig } };
}

export function isToolEnabledByDefault(config: ToolDefaultsConfig, toolName: string): boolean {
	return config.tools[toolName] ?? true;
}

function parseToolMap(value: unknown, sourcePath: string): Record<string, boolean> {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ToolDefaultsConfigError("tools config must be an object.", { path: sourcePath });
	}

	const result: Record<string, boolean> = {};
	for (const [toolName, enabled] of Object.entries(value)) {
		if (toolName === "$schema") {
			if (typeof enabled !== "string") throw new ToolDefaultsConfigError("$schema must be a string.", { path: sourcePath });
			continue;
		}
		if (typeof enabled !== "boolean") {
			throw new ToolDefaultsConfigError("tools config values must be boolean.", { path: sourcePath, tool: toolName });
		}
		result[toolName] = enabled;
	}
	return result;
}

async function readOptionalConfig(filePath: string): Promise<{ value: unknown } | undefined> {
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw new ToolDefaultsConfigError("tools config cannot be read.", { path: filePath });
	}

	const errors: ParseError[] = [];
	const value = parse(text, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const first = errors[0];
		throw new ToolDefaultsConfigError("tools config is not valid JSONC.", {
			path: filePath,
			error: first ? printParseErrorCode(first.error) : "unknown",
			offset: first?.offset,
		});
	}
	return { value };
}

function userConfigPath(): string {
	return process.env[USER_CONFIG_ENV] ?? path.join(os.homedir(), ".pi", "agent", "tools.jsonc");
}

function projectConfigPath(cwd: string): string | undefined {
	if (process.env[PROJECT_CONFIG_ENV]) return process.env[PROJECT_CONFIG_ENV];
	const root = process.env[PROJECT_ROOT_ENV] ?? findNearestProjectRoot(cwd);
	return root === undefined ? undefined : path.join(root, ".pi", "tools.jsonc");
}

export function findNearestProjectRoot(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		if (existsSync(path.join(current, ".pi"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
