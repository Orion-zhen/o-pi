import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installationRoot } from "./runtime/paths.ts";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { compileSchemaValidator, type SchemaValidateFunction } from "./schema-validator.ts";
import { mergeConfigValues } from "./config-values.ts";

export class ConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "ConfigError";
	}
}

export type ConfigLayerKind = "default" | "user" | "project";

export interface ConfigDefinition {
	label: string;
	fileName: string;
	userEnv: string;
	project?: { configEnv: string; rootEnv: string };
	projectSchema?: string;
}

export interface ConfigLayerPath {
	kind: ConfigLayerKind;
	path: string;
}

export interface LoadedConfigLayer extends ConfigLayerPath {
	value: unknown;
}

export interface LoadedConfigLayers {
	layers: [LoadedConfigLayer, ...LoadedConfigLayer[]];
	fingerprint: string;
}

/** 配置范围与 schema 的唯一装配入口。 */
export const CONFIG_DEFINITIONS = {
	approvalGate: globalConfig("approval-gate", "approval-gate.jsonc", "PI_APPROVAL_GATE_CONFIG"),
	autoTitle: globalConfig("auto-title", "auto-title.jsonc", "PI_AUTO_TITLE_CONFIG"),
	bashTool: globalConfig("bash-tool", "bash-tool.jsonc", "PI_BASH_TOOL_CONFIG"),
	discordPresence: projectConfig("discord-presence", "discord-presence.jsonc", "PI_DISCORD_PRESENCE_CONFIG", "PI_DISCORD_PRESENCE_PROJECT_CONFIG", "PI_DISCORD_PRESENCE_PROJECT_ROOT"),
	fileTools: projectConfig("file-tools", "file-tools.jsonc", "PI_FILE_TOOLS_CONFIG", "PI_FILE_TOOLS_PROJECT_CONFIG", "PI_FILE_TOOLS_PROJECT_ROOT"),
	lsp: projectConfig("lsp", "lsp.jsonc", "PI_LSP_CONFIG", "PI_LSP_PROJECT_CONFIG", "PI_LSP_PROJECT_ROOT"),
	subagent: {
		...projectConfig("subagent", "subagent.jsonc", "PI_SUBAGENT_USER_CONFIG", "PI_SUBAGENT_PROJECT_CONFIG", "PI_SUBAGENT_PROJECT_ROOT"),
		projectSchema: "subagent-project.schema.json",
	},
	gui: globalConfig("gui", "gui.jsonc", "PI_GUI_CONFIG"),
	tui: globalConfig("tui", "tui.jsonc", "PI_TUI_CONFIG"),
	webTools: globalConfig("web-tools", "web-tools.jsonc", "PI_WEB_TOOLS_CONFIG"),
} as const satisfies Record<string, ConfigDefinition>;

async function readOptionalConfig(definition: ConfigDefinition, source: ConfigLayerPath): Promise<unknown | undefined> {
	let text: string;
	try {
		text = await readFile(source.path, "utf8");
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw new ConfigError(`${definition.label} ${source.kind} config cannot be read.`, { layer: source.kind, path: source.path });
	}
	return parseConfig(text, `${definition.label} ${source.kind}`, source.path, source.kind);
}

function parseConfig(text: string, label: string, filePath: string, layer?: ConfigLayerKind): unknown {
	const errors: ParseError[] = [];
	const value: unknown = parse(stripUtf8Bom(text), errors, { allowTrailingComma: true });
	const first = errors[0];
	if (first) throw new ConfigError(`${label} config is not valid JSONC.`, {
		...(layer === undefined ? {} : { layer }),
		path: filePath, error: printParseErrorCode(first.error), offset: first.offset,
	});
	return value;
}

export function validateConfigLayer(definition: ConfigDefinition, layer: LoadedConfigLayer): void {
	const validator = configValidator(definition, layer.kind);
	if (!validator(layer.value)) {
		throw new ConfigError(`${definition.label} ${layer.kind} config does not match schema.`, {
			layer: layer.kind, path: layer.path, errors: validator.errors ?? [],
		});
	}
}

/** 必需默认层与可选覆盖层来自同一个稳定的文件快照。 */
export async function loadConfigLayers(definition: ConfigDefinition, cwd: string): Promise<LoadedConfigLayers> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const paths = resolveConfigLayerPaths(definition, cwd);
		const before = await configLayerFingerprint(paths);
		const [defaultSource, ...optionalSources] = paths;
		const defaultValue = await readOptionalConfig(definition, defaultSource);
		if (defaultValue === undefined) {
			throw new ConfigError(`${definition.label} default config is missing.`, { layer: defaultSource.kind, path: defaultSource.path });
		}
		const layers: [LoadedConfigLayer, ...LoadedConfigLayer[]] = [{ ...defaultSource, value: defaultValue }];
		for (const source of optionalSources) {
			const value = await readOptionalConfig(definition, source);
			if (value !== undefined) layers.push({ ...source, value });
		}
		const after = await configLayerFingerprint(paths);
		if (before === after) return { layers, fingerprint: after };
	}
	throw new ConfigError(`${definition.label} config changed while being read.`, {
		paths: resolveConfigLayerPaths(definition, cwd).map((source) => source.path),
	});
}

export async function loadValidatedConfigLayers(definition: ConfigDefinition, cwd: string): Promise<LoadedConfigLayers> {
	const loaded = await loadConfigLayers(definition, cwd);
	for (const layer of loaded.layers) validateConfigLayer(definition, layer);
	return loaded;
}

export async function loadValidatedMergedConfig<T>(
	definition: ConfigDefinition,
	cwd: string,
): Promise<LoadedConfigLayers & { merged: T }> {
	const loaded = await loadValidatedConfigLayers(definition, cwd);
	let merged: unknown = {};
	for (const layer of loaded.layers) merged = mergeConfigValues(merged, layer.value);
	return { ...loaded, merged: merged as T };
}

export function resolveConfigLayerPaths(definition: ConfigDefinition, cwd: string): [ConfigLayerPath, ...ConfigLayerPath[]] {
	const paths: [ConfigLayerPath, ...ConfigLayerPath[]] = [
		{ kind: "default", path: defaultAgentConfigPath(definition.fileName) },
		{ kind: "user", path: userAgentConfigPath(definition.fileName, definition.userEnv) },
	];
	if (definition.project === undefined) return paths;
	const projectPath = projectAgentConfigPath(cwd, definition.fileName, definition.project.configEnv, definition.project.rootEnv);
	if (projectPath !== undefined) paths.push({ kind: "project", path: projectPath });
	return paths;
}

export async function configLayerFingerprint(paths: readonly ConfigLayerPath[]): Promise<string> {
	return (await Promise.all(paths.map(async (source) => `${source.kind}:${await fileFingerprint(source.path)}`))).join("|");
}

/** 移除解码文本开头的 UTF-8 BOM 标记。 */
export function stripUtf8Bom(text: string): string {
	return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

const validators = new WeakMap<ConfigDefinition, Map<ConfigLayerKind, SchemaValidateFunction>>();

export function configValidator(definition: ConfigDefinition, kind: ConfigLayerKind = "user"): SchemaValidateFunction {
	if (kind === "project" && definition.projectSchema === undefined) kind = "user";
	let cached = validators.get(definition);
	if (cached === undefined) {
		cached = new Map();
		validators.set(definition, cached);
	}
	let validator = cached.get(kind);
	if (validator === undefined) {
		const fileName = kind === "project" && definition.projectSchema !== undefined
			? definition.projectSchema
			: definition.fileName.replace(/\.jsonc$/u, ".schema.json");
		const label = kind === "project" && definition.projectSchema !== undefined ? `${definition.label} project` : definition.label;
		validator = compileValidator(agentSchemaPath(fileName), label, kind === "default");
		cached.set(kind, validator);
	}
	return validator;
}

export function readDefaultJsoncConfigSync<T>(definition: ConfigDefinition): T {
	const configPath = defaultAgentConfigPath(definition.fileName);
	let text: string;
	try {
		text = readFileSync(configPath, "utf8");
	} catch {
		throw new ConfigError(`${definition.label} default config cannot be read.`, { path: configPath });
	}
	const value = parseConfig(text, `${definition.label} default`, configPath);
	const validator = configValidator(definition, "default");
	if (!validator(value)) {
		throw new ConfigError(`${definition.label} default config does not match schema.`, {
			path: configPath, errors: validator.errors ?? [],
		});
	}
	return value as T;
}

function compileValidator(schemaPath: string, label: string, complete: boolean): SchemaValidateFunction {
	let schema: unknown;
	try {
		schema = JSON.parse(readFileSync(schemaPath, "utf8"));
	} catch {
		throw new ConfigError(`${label} schema cannot be read.`, { path: schemaPath });
	}
	if (!isRecord(schema)) throw new ConfigError(`${label} schema is invalid.`, { path: schemaPath });
	try {
		return compileSchemaValidator(complete ? requireFixedProperties(schema) : schema, { allErrors: true });
	} catch (error) {
		throw new ConfigError(`${label} schema is invalid.`, {
			path: schemaPath, error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function expandHomePath(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
	return value;
}

export function defaultAgentConfigPath(fileName: string): string {
	return path.join(installationRoot(), "agent", "defaults", fileName);
}

export function agentSchemaPath(fileName: string): string {
	return path.join(installationRoot(), "agent", "schemas", fileName);
}

export function userAgentConfigPath(fileName: string, envName: string): string {
	return process.env[envName] ?? path.join(os.homedir(), ".pi", "agent", "configs", fileName);
}

export function userAgentPath(fileName: string, envName: string): string {
	return process.env[envName] ?? path.join(os.homedir(), ".pi", "agent", fileName);
}

function projectAgentConfigPath(cwd: string, fileName: string, configEnvName: string, rootEnvName: string): string | undefined {
	if (process.env[configEnvName]) return process.env[configEnvName];
	const root = process.env[rootEnvName] ?? findNearestProjectRoot(cwd);
	return root === undefined ? undefined : path.join(root, ".pi", "configs", fileName);
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

export function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function globalConfig(label: string, fileName: string, userEnv: string): ConfigDefinition {
	return { label, fileName, userEnv };
}

function projectConfig(label: string, fileName: string, userEnv: string, configEnv: string, rootEnv: string): ConfigDefinition {
	return { label, fileName, userEnv, project: { configEnv, rootEnv } };
}

async function fileFingerprint(filePath: string): Promise<string> {
	try {
		const info = await stat(filePath);
		return `${filePath}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
	} catch (error) {
		if (isNotFound(error)) return `${filePath}:missing`;
		return `${filePath}:unreadable`;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireFixedProperties(schema: Record<string, unknown>): Record<string, unknown> {
	const copy: Record<string, unknown> = structuredClone(schema);
	const properties = copy["properties"];
	if (!isRecord(properties)) return copy;
	const names = Object.keys(properties).filter((name) => name !== "$schema");
	if (names.length > 0) copy["required"] = names;
	for (const [name, child] of Object.entries(properties)) {
		if (isRecord(child) && child["type"] === "object") properties[name] = requireFixedProperties(child);
	}
	return copy;
}
