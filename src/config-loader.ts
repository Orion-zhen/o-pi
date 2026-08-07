import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { compileSchemaValidator, type SchemaValidateFunction } from "./schema-validator.js";

export { expandHomePath, userCachePath } from "./cache-path.js";

export type ConfigErrorFactory<E extends Error> = (message: string, details?: Record<string, unknown>) => E;
export type ConfigLayerKind = "default" | "user" | "project";

export interface ReadJsoncConfigOptions<E extends Error> {
	path: string;
	label: string;
	createError: ConfigErrorFactory<E>;
}

export interface ReadJsoncConfigWithSchemaOptions<E extends Error> extends ReadJsoncConfigOptions<E> {
	loadValidator: () => Promise<SchemaValidateFunction>;
}

export interface SchemaValidatorOptions<E extends Error> {
	schemaPath: string;
	label: string;
	createError: ConfigErrorFactory<E>;
	/** 完整默认层中允许省略、由模块运行时补齐的点分属性路径。 */
	optionalCompleteProperties?: readonly string[];
}

export interface ReadDefaultJsoncConfigOptions<E extends Error> extends SchemaValidatorOptions<E> {
	configPath: string;
}

export interface ProjectConfigDefinition {
	configEnv: string;
	rootEnv: string;
}

export interface ConfigDefinition {
	label: string;
	fileName: string;
	userEnv: string;
	project?: ProjectConfigDefinition;
}

export interface ConfigLayerPath {
	kind: ConfigLayerKind;
	path: string;
	required: boolean;
}

export interface LoadedConfigLayer extends ConfigLayerPath {
	value: unknown;
}

export interface LoadedConfigLayers {
	layers: LoadedConfigLayer[];
	paths: ConfigLayerPath[];
	fingerprint: string;
}

export interface ConfigLayerValidators {
	partial: () => Promise<SchemaValidateFunction>;
	complete: () => Promise<SchemaValidateFunction>;
}

export interface LoadedValidatedMergedConfig extends LoadedConfigLayers {
	merged: unknown;
}

/** 分层代理配置及其允许范围的中央注册中心。 */
export const CONFIG_DEFINITIONS = {
	approvalGate: globalConfig("approval-gate", "approval-gate.jsonc", "PI_APPROVAL_GATE_CONFIG"),
	bashTool: globalConfig("bash-tool", "bash-tool.jsonc", "PI_BASH_TOOL_CONFIG"),
	fileTools: projectConfig("file-tools", "file-tools.jsonc", "PI_FILE_TOOLS_CONFIG", "PI_FILE_TOOLS_PROJECT_CONFIG", "PI_FILE_TOOLS_PROJECT_ROOT"),
	lsp: projectConfig("lsp", "lsp.jsonc", "PI_LSP_CONFIG", "PI_LSP_PROJECT_CONFIG", "PI_LSP_PROJECT_ROOT"),
	subagent: projectConfig("subagent", "subagent.jsonc", "PI_SUBAGENT_USER_CONFIG", "PI_SUBAGENT_PROJECT_CONFIG", "PI_SUBAGENT_PROJECT_ROOT"),
	tui: globalConfig("tui", "tui.jsonc", "PI_TUI_CONFIG"),
	webTools: globalConfig("web-tools", "web-tools.jsonc", "PI_WEB_TOOLS_CONFIG"),
} as const satisfies Record<string, ConfigDefinition>;

export async function readOptionalJsoncConfig<E extends Error>(options: ReadJsoncConfigOptions<E>): Promise<unknown | undefined> {
	let text: string;
	try {
		text = await readFile(options.path, "utf8");
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw options.createError(`${options.label} config cannot be read.`, { path: options.path });
	}

	const errors: ParseError[] = [];
	const value = parse(text, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const first = errors[0];
		throw options.createError(`${options.label} config is not valid JSONC.`, {
			path: options.path,
			error: first ? printParseErrorCode(first.error) : "unknown",
			offset: first?.offset,
		});
	}
	return value;
}

export async function readOptionalJsoncConfigWithSchema<E extends Error>(
	options: ReadJsoncConfigWithSchemaOptions<E>,
): Promise<unknown | undefined> {
	const value = await readOptionalJsoncConfig(options);
	if (value === undefined) return undefined;
	await validateConfigValue({ ...options, value });
	return value;
}

export async function validateConfigValue<E extends Error>(
	options: ReadJsoncConfigWithSchemaOptions<E> & { value: unknown; layer?: ConfigLayerKind },
): Promise<void> {
	const validator = await options.loadValidator();
	if (!validator(options.value)) {
		throw options.createError(`${options.label} config does not match schema.`, {
			...(options.layer === undefined ? {} : { layer: options.layer }),
			path: options.path,
			errors: validator.errors ?? [],
		});
	}
}

/** 读取一个必需的追踪默认值，外加可选的用户和项目叠加层，并将其作为一个稳定的快照进行读取。 */
export async function loadConfigLayers<E extends Error>(
	definition: ConfigDefinition,
	cwd: string,
	createError: ConfigErrorFactory<E>,
): Promise<LoadedConfigLayers> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const paths = resolveConfigLayerPaths(definition, cwd);
		const before = await configLayerFingerprint(paths);
		const layers: LoadedConfigLayer[] = [];
		for (const source of paths) {
			const value = await readOptionalJsoncConfig({
				path: source.path,
				label: `${definition.label} ${source.kind}`,
				createError: (message, details) => createError(message, { layer: source.kind, ...details }),
			});
			if (value === undefined) {
				if (source.required) {
					throw createError(`${definition.label} default config is missing.`, { layer: source.kind, path: source.path });
				}
				continue;
			}
			layers.push({ ...source, value });
		}
		const after = await configLayerFingerprint(paths);
		if (before === after) return { layers, paths, fingerprint: after };
	}
	throw createError(`${definition.label} config changed while being read.`, {
		paths: resolveConfigLayerPaths(definition, cwd).map((source) => source.path),
	});
}

export async function loadValidatedMergedConfig<E extends Error>(
	definition: ConfigDefinition,
	cwd: string,
	createError: ConfigErrorFactory<E>,
	validators: ConfigLayerValidators,
): Promise<LoadedValidatedMergedConfig> {
	const loaded = await loadConfigLayers(definition, cwd, createError);
	let merged: unknown = {};
	for (const layer of loaded.layers) {
		await validateConfigValue({
			path: layer.path,
			label: `${definition.label} ${layer.kind}`,
			value: layer.value,
			layer: layer.kind,
			loadValidator: layer.kind === "default" ? validators.complete : validators.partial,
			createError,
		});
		merged = mergeConfigValues(merged, layer.value);
	}
	return { ...loaded, merged };
}

export function resolveConfigLayerPaths(definition: ConfigDefinition, cwd: string): ConfigLayerPath[] {
	const paths: ConfigLayerPath[] = [
		{ kind: "default", path: defaultAgentConfigPath(definition.fileName), required: true },
		{ kind: "user", path: userAgentConfigPath(definition.fileName, definition.userEnv), required: false },
	];
	if (definition.project === undefined) return paths;
	const projectPath = projectAgentConfigPath(cwd, definition.fileName, definition.project.configEnv, definition.project.rootEnv);
	if (projectPath !== undefined) paths.push({ kind: "project", path: projectPath, required: false });
	return paths;
}

export async function configLayerFingerprint(paths: readonly ConfigLayerPath[]): Promise<string> {
	return (await Promise.all(paths.map(async (source) => `${source.kind}:${await fileFingerprint(source.path)}`))).join("|");
}

/** 深度合并 JSON 对象；数组和标量值将被高层级的值覆盖。 */
export function mergeConfigValues(base: unknown, overlay: unknown): unknown {
	if (!isRecord(base) || !isRecord(overlay)) return structuredClone(overlay);
	const merged: Record<string, unknown> = structuredClone(base);
	for (const [key, value] of Object.entries(overlay)) {
		merged[key] = key in merged ? mergeConfigValues(merged[key], value) : structuredClone(value);
	}
	return merged;
}

export function createSchemaValidator<E extends Error>(options: SchemaValidatorOptions<E>): () => Promise<SchemaValidateFunction> {
	return createSchemaValidatorInternal(options, false);
}

export function createCompleteSchemaValidator<E extends Error>(options: SchemaValidatorOptions<E>): () => Promise<SchemaValidateFunction> {
	return createSchemaValidatorInternal(options, true);
}

export function readDefaultJsoncConfigSync<E extends Error>(options: ReadDefaultJsoncConfigOptions<E>): unknown {
	let text: string;
	try {
		text = readFileSync(options.configPath, "utf8");
	} catch {
		throw options.createError(`${options.label} default config cannot be read.`, { path: options.configPath });
	}
	const errors: ParseError[] = [];
	const value = parse(text, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const first = errors[0];
		throw options.createError(`${options.label} default config is not valid JSONC.`, {
			path: options.configPath,
			error: first ? printParseErrorCode(first.error) : "unknown",
			offset: first?.offset,
		});
	}
	let schema: unknown;
	try {
		schema = JSON.parse(readFileSync(options.schemaPath, "utf8"));
	} catch {
		throw options.createError(`${options.label} schema cannot be read.`, { path: options.schemaPath });
	}
	if (!isRecord(schema)) throw options.createError(`${options.label} schema is invalid.`, { path: options.schemaPath });
	let validator: SchemaValidateFunction;
	try {
		validator = compileSchemaValidator(requireFixedProperties(schema, options.optionalCompleteProperties), { allErrors: true });
	} catch (error) {
		throw options.createError(`${options.label} schema is invalid.`, {
			path: options.schemaPath,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	if (!validator(value)) {
		throw options.createError(`${options.label} default config does not match schema.`, {
			path: options.configPath,
			errors: validator.errors ?? [],
		});
	}
	return value;
}

function createSchemaValidatorInternal<E extends Error>(
	options: SchemaValidatorOptions<E>,
	requireComplete: boolean,
): () => Promise<SchemaValidateFunction> {
	let compiledValidator: SchemaValidateFunction | undefined;
	let validatorPromise: Promise<SchemaValidateFunction> | undefined;
	return () => {
		if (compiledValidator !== undefined) return Promise.resolve(compiledValidator);
		if (validatorPromise !== undefined) return validatorPromise;
		const pending = compileValidator();
		validatorPromise = pending;
		void pending.catch(() => {
			if (validatorPromise === pending) validatorPromise = undefined;
		});
		return pending;
	};

	async function compileValidator(): Promise<SchemaValidateFunction> {
		let schema: unknown;
		try {
			schema = JSON.parse(await readFile(options.schemaPath, "utf8"));
		} catch {
			throw options.createError(`${options.label} schema cannot be read.`, { path: options.schemaPath });
		}
		if (!isRecord(schema)) throw options.createError(`${options.label} schema is invalid.`, { path: options.schemaPath });
		try {
			const validator = compileSchemaValidator(
				requireComplete ? requireFixedProperties(schema, options.optionalCompleteProperties) : schema,
				{ allErrors: true },
			);
			compiledValidator = validator;
			return validator;
		} catch (error) {
			throw options.createError(`${options.label} schema is invalid.`, {
				path: options.schemaPath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

export function repoRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function agentPath(...segments: string[]): string {
	return path.join(repoRoot(), "agent", ...segments);
}

export function defaultAgentConfigPath(fileName: string): string {
	return agentPath("defaults", fileName);
}

export function agentSchemaPath(fileName: string): string {
	return agentPath("schemas", fileName);
}

export function userAgentConfigPath(fileName: string, envName: string): string {
	return process.env[envName] ?? path.join(os.homedir(), ".pi", "agent", "configs", fileName);
}

export function userAgentPath(fileName: string, envName: string): string {
	return process.env[envName] ?? path.join(os.homedir(), ".pi", "agent", fileName);
}

export function projectAgentConfigPath(cwd: string, fileName: string, configEnvName: string, rootEnvName: string): string | undefined {
	if (process.env[configEnvName]) return process.env[configEnvName];
	const root = process.env[rootEnvName] ?? findNearestProjectRoot(cwd);
	return root === undefined ? undefined : path.join(root, ".pi", "configs", fileName);
}

export function projectPiPath(cwd: string, fileName: string, configEnvName: string, rootEnvName: string): string | undefined {
	if (process.env[configEnvName]) return process.env[configEnvName];
	const root = process.env[rootEnvName] ?? findNearestProjectRoot(cwd);
	return root === undefined ? undefined : path.join(root, ".pi", fileName);
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

function projectConfig(
	label: string,
	fileName: string,
	userEnv: string,
	configEnv: string,
	rootEnv: string,
): ConfigDefinition {
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

function requireFixedProperties(
	schema: Record<string, unknown>,
	optionalProperties: readonly string[] = [],
	parentPath = "",
): Record<string, unknown> {
	const copy: Record<string, unknown> = structuredClone(schema);
	const properties = copy["properties"];
	if (!isRecord(properties)) return copy;
	const optional = new Set(optionalProperties);
	const propertyPath = (name: string) => parentPath === "" ? name : `${parentPath}.${name}`;
	const names = Object.keys(properties).filter((name) => name !== "$schema" && !optional.has(propertyPath(name)));
	if (names.length > 0) copy["required"] = names;
	for (const [name, child] of Object.entries(properties)) {
		if (isRecord(child) && child["type"] === "object") {
			properties[name] = requireFixedProperties(child, optionalProperties, propertyPath(name));
		}
	}
	return copy;
}
