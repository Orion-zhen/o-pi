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
} from "../config-loader.ts";

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

interface ToolDefaultsInput {
	defaults?: Record<string, boolean>;
	rules?: Array<{ match: string; tools: Record<string, boolean> }>;
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
	if (userConfig !== undefined) layers.push(parseLayer(userConfig));

	const projectPath = projectConfigPath(cwd);
	if (projectPath !== undefined) {
		const projectConfig = await readOptionalConfig(projectPath);
		if (projectConfig !== undefined) layers.push(parseLayer(projectConfig));
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

function parseLayer(value: ToolDefaultsInput): ToolDefaultsLayer {
	const rules = (value.rules ?? []).map(({ match, tools }): ToolDefaultsRule => {
		const wildcardIndex = match.indexOf("*");
		return {
			match, tools,
			staticPrefixLength: wildcardIndex === -1 ? match.length : wildcardIndex,
			exact: wildcardIndex === -1,
			expression: compileMatchPattern(match),
		};
	});
	return { defaults: value.defaults ?? {}, rules: rules.sort(compareRules) };
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

async function readOptionalConfig(filePath: string): Promise<ToolDefaultsInput | undefined> {
	return readOptionalJsoncConfigWithSchema<ToolDefaultsInput>({
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
