import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import {
	agentSchemaPath,
	createSchemaValidator,
	findNearestProjectRoot as findNearestProjectRootBase,
	isNotFound,
	projectPiPath,
	readOptionalJsoncConfigWithSchema,
	stripUtf8Bom,
	userAgentPath,
	validateConfigValue,
} from "../config-loader.js";

const TOOL_CONFIG_FORMAT = { insertSpaces: true, tabSize: 2, eol: "\n", insertFinalNewline: true } as const;

const USER_CONFIG_ENV = "PI_TOOLS_CONFIG";
const PROJECT_CONFIG_ENV = "PI_TOOLS_PROJECT_CONFIG";
const PROJECT_ROOT_ENV = "PI_TOOLS_PROJECT_ROOT";

export const findNearestProjectRoot = findNearestProjectRootBase;

export interface ToolDefaultsModel {
	provider: string;
	id: string;
}

interface ToolDefaultsRule {
	readonly match: string;
	readonly tools: Readonly<Record<string, boolean>>;
	readonly staticPrefixLength: number;
	readonly exact: boolean;
	readonly expression: RegExp;
}

interface ToolDefaultsLayer {
	readonly defaults: Readonly<Record<string, boolean>>;
	readonly rules: readonly ToolDefaultsRule[];
}

export interface ToolDefaultsConfig {
	readonly layers: readonly ToolDefaultsLayer[];
}

export class ToolDefaultsConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "ToolDefaultsConfigError";
	}
}

const loadToolsValidator = createSchemaValidator({
	schemaPath: agentSchemaPath("tools.schema.json"),
	label: "tools",
	createError: (message, details) => new ToolDefaultsConfigError(message, details),
});

export async function loadToolDefaultsConfig(cwd = process.cwd()): Promise<ToolDefaultsConfig> {
	const layers: ToolDefaultsLayer[] = [];
	const userPath = userConfigPath();
	const userConfig = await readOptionalConfig(userPath);
	if (userConfig !== undefined) layers.push(parseLayer(userConfig, userPath));

	const projectPath = projectConfigPath(cwd);
	if (projectPath !== undefined) {
		const projectConfig = await readOptionalConfig(projectPath);
		if (projectConfig !== undefined) layers.push(parseLayer(projectConfig, projectPath));
	}

	return { layers };
}

/** 将完整工具选择写入用户层 defaults，并保留 defaults 之外的字段和注释。 */
export async function saveUserToolDefaults(defaults: Readonly<Record<string, boolean>>): Promise<string> {
	const filePath = userConfigPath();
	await writeUserToolDefaults(filePath, defaults);
	return filePath;
}

export function resolveToolDefaults(
	config: ToolDefaultsConfig,
	model: ToolDefaultsModel | undefined,
): Readonly<Record<string, boolean>> {
	const resolved: Record<string, boolean> = {};
	const modelKey = model === undefined ? undefined : `${model.provider}/${model.id}`;

	for (const layer of config.layers) {
		Object.assign(resolved, layer.defaults);
		if (modelKey === undefined) continue;
		for (const rule of layer.rules) {
			if (rule.expression.test(modelKey)) Object.assign(resolved, rule.tools);
		}
	}

	return resolved;
}

function parseLayer(value: unknown, sourcePath: string): ToolDefaultsLayer {
	if (!isRecord(value)) throw new ToolDefaultsConfigError("tools config must be an object.", { path: sourcePath });
	const defaults = value["defaults"] === undefined ? {} : parseToolMap(value["defaults"], sourcePath);
	const rawRules = value["rules"];
	if (rawRules === undefined) return { defaults, rules: [] };
	if (!Array.isArray(rawRules)) throw new ToolDefaultsConfigError("tools config rules must be an array.", { path: sourcePath });

	const rules = rawRules.map((rawRule, index) => parseRule(rawRule, sourcePath, index));
	rules.sort(compareRules);
	return { defaults, rules };
}

function parseRule(value: unknown, sourcePath: string, index: number): ToolDefaultsRule {
	if (!isRecord(value) || typeof value["match"] !== "string") {
		throw new ToolDefaultsConfigError("tools config rule is invalid.", { path: sourcePath, rule: index });
	}
	const match = value["match"];
	const wildcardIndex = match.indexOf("*");
	return {
		match,
		tools: parseToolMap(value["tools"], sourcePath),
		staticPrefixLength: wildcardIndex === -1 ? match.length : wildcardIndex,
		exact: wildcardIndex === -1,
		expression: compileMatchPattern(match),
	};
}

function parseToolMap(value: unknown, sourcePath: string): Record<string, boolean> {
	if (!isRecord(value)) throw new ToolDefaultsConfigError("tools map must be an object.", { path: sourcePath });
	const tools: Record<string, boolean> = {};
	for (const [toolName, enabled] of Object.entries(value)) {
		if (typeof enabled !== "boolean") {
			throw new ToolDefaultsConfigError("tool states must be boolean.", { path: sourcePath, tool: toolName });
		}
		tools[toolName] = enabled;
	}
	return tools;
}

function compareRules(left: ToolDefaultsRule, right: ToolDefaultsRule): number {
	return left.staticPrefixLength - right.staticPrefixLength || Number(left.exact) - Number(right.exact);
}

function compileMatchPattern(pattern: string): RegExp {
	const source = pattern.split(/\*+/u).map(escapeRegExp).join(".*");
	return new RegExp(`^${source}$`, "u");
}

function escapeRegExp(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOptionalConfig(filePath: string): Promise<unknown | undefined> {
	return readOptionalJsoncConfigWithSchema({
		path: filePath,
		label: "tools",
		createError: (message, details) => new ToolDefaultsConfigError(message, details),
		loadValidator: loadToolsValidator,
	});
}

async function writeUserToolDefaults(filePath: string, defaults: Readonly<Record<string, boolean>>): Promise<void> {
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if (!isNotFound(error)) throw error;
		text = "{}\n";
	}

	const hasBom = text.startsWith("\uFEFF");
	const source = stripUtf8Bom(text);
	const errors: ParseError[] = [];
	const value = parse(source, errors, { allowTrailingComma: true });
	const firstError = errors.at(0);
	if (firstError !== undefined) {
		throw new ToolDefaultsConfigError("tools config is not valid JSONC.", {
			path: filePath,
			error: printParseErrorCode(firstError.error),
			offset: firstError.offset,
		});
	}
	await validateConfigValue({
		path: filePath,
		label: "tools",
		value,
		loadValidator: loadToolsValidator,
		createError: (message, details) => new ToolDefaultsConfigError(message, details),
	});

	const updated = applyEdits(source, modify(source, ["defaults"], defaults, {
		formattingOptions: TOOL_CONFIG_FORMAT,
	}));
	await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	await writeFile(filePath, `${hasBom ? "\uFEFF" : ""}${updated}`, { encoding: "utf8", mode: 0o600 });
}

function userConfigPath(): string {
	return userAgentPath("tools.jsonc", USER_CONFIG_ENV);
}

function projectConfigPath(cwd: string): string | undefined {
	return projectPiPath(cwd, "tools.jsonc", PROJECT_CONFIG_ENV, PROJECT_ROOT_ENV);
}
