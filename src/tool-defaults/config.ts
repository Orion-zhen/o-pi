import { findNearestProjectRoot as findNearestProjectRootBase, projectPiPath, readOptionalJsoncConfig, userAgentPath } from "../config-loader.js";

const USER_CONFIG_ENV = "PI_TOOLS_CONFIG";
const PROJECT_CONFIG_ENV = "PI_TOOLS_PROJECT_CONFIG";
const PROJECT_ROOT_ENV = "PI_TOOLS_PROJECT_ROOT";

export const findNearestProjectRoot = findNearestProjectRootBase;

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
	const value = await readOptionalJsoncConfig({
		path: filePath,
		label: "tools",
		createError: (message, details) => new ToolDefaultsConfigError(message, details),
	});
	return value === undefined ? undefined : { value };
}

function userConfigPath(): string {
	return userAgentPath("tools.jsonc", USER_CONFIG_ENV);
}

function projectConfigPath(cwd: string): string | undefined {
	return projectPiPath(cwd, "tools.jsonc", PROJECT_CONFIG_ENV, PROJECT_ROOT_ENV);
}
