import path from "node:path";

import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	createCompleteSchemaValidator,
	createSchemaValidator,
	expandHomePath,
	loadConfigLayers,
	userAgentConfigPath,
	validateConfigValue,
} from "../../config-loader.js";
import { validateServerRoutes } from "./routing.js";
import type { LoadedLspConfig, LspConfig, LspJsonValue, LspLanguageRoute, LspServerConfig, LspTransport } from "../types.js";

const CONFIG_PATH_ENV = "PI_LSP_CONFIG";
const SCHEMA_PATH = agentSchemaPath("lsp.schema.json");

type RawSelectors = string | string[];

/** LSP 配置读取、JSONC 解析或 schema 校验失败。 */
export class LspConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "LspConfigError";
	}
}

interface RawLspServer {
	enabled?: boolean;
	fallback?: boolean;
	command?: [string, ...string[]];
	tcp?: {
		host: string;
		port: number;
	};
	languages: Record<string, RawSelectors>;
	init?: LspJsonValue;
	settings?: LspJsonValue;
}

interface RawLspConfig {
	enabled?: boolean;
	exclude_paths?: string[];
	startup_timeout_ms?: number;
	request_timeout_ms?: number;
	idle_timeout_ms?: number;
	max_open_documents?: number;
	diagnostics?: Partial<LspConfig["diagnostics"]>;
	read?: Partial<LspConfig["read"]>;
	grep?: Partial<LspConfig["grep"]>;
	servers?: Record<string, RawLspServer>;
}

interface CompleteLspConfig extends Required<RawLspConfig> {
	diagnostics: LspConfig["diagnostics"];
	read: LspConfig["read"];
	grep: LspConfig["grep"];
	servers: Record<string, RawLspServer>;
}

/** 读取全局与项目级 LSP JSONC 配置；项目配置按字段覆盖全局配置。 */
export async function loadLspConfig(cwd = process.cwd()): Promise<LoadedLspConfig> {
	const loaded = await loadConfigLayers(CONFIG_DEFINITIONS.lsp, cwd, createError);
	let raw: RawLspConfig = {};
	for (const layer of loaded.layers) {
		if (layer.kind === "default") {
			await validateConfigValue({ path: layer.path, label: "lsp default", value: layer.value, layer: layer.kind, loadValidator: loadCompleteValidator, createError });
		}
		raw = layer.kind === "project"
			? mergeRawConfig(raw, layer.value as RawLspConfig)
			: mergeUserRawConfig(raw, layer.value as RawLspConfig);
	}
	const configPath = loaded.layers.at(-1)?.path ?? loaded.paths[0]?.path ?? resolveLspConfigPath();
	await validateRawConfig(raw, configPath);
	return { path: configPath, config: materializeConfig(raw as CompleteLspConfig) };
}

export function resolveLspConfigPath(): string {
	return userAgentConfigPath("lsp.jsonc", CONFIG_PATH_ENV);
}

async function validateRawConfig(raw: RawLspConfig, configPath: string): Promise<void> {
	const validator = await loadValidator();
	if (!validator(raw)) {
		throw new LspConfigError("lsp config does not match schema.", {
			path: configPath,
			errors: validator.errors ?? [],
		});
	}
}

function mergeUserRawConfig(defaults: RawLspConfig, user: RawLspConfig): RawLspConfig {
	const merged = mergeRawConfig(defaults, user);
	if (user.servers !== undefined) merged.servers = user.servers;
	return merged;
}

function mergeRawConfig(global: RawLspConfig, project: RawLspConfig): RawLspConfig {
	const merged: RawLspConfig = { ...global, ...project };
	const diagnostics = mergeObject(global.diagnostics, project.diagnostics);
	const read = mergeObject(global.read, project.read);
	const grep = mergeObject(global.grep, project.grep);
	const servers = mergeServers(global.servers, project.servers);
	if (diagnostics !== undefined) merged.diagnostics = diagnostics;
	if (read !== undefined) merged.read = read;
	if (grep !== undefined) merged.grep = grep;
	if (servers !== undefined) merged.servers = servers;
	return merged;
}

function mergeServers(
	global: RawLspConfig["servers"],
	project: RawLspConfig["servers"],
): RawLspConfig["servers"] {
	if (global === undefined) return project;
	if (project === undefined) return global;
	const merged = { ...global };
	for (const [id, projectServer] of Object.entries(project)) {
		const globalServer = global[id];
		const init = mergeJsonValue(globalServer?.init, projectServer.init);
		const settings = mergeJsonValue(globalServer?.settings, projectServer.settings);
		const mergedServer: RawLspServer = {
			...globalServer,
			...projectServer,
			languages: { ...globalServer?.languages, ...projectServer.languages },
		};
		if (init !== undefined) mergedServer.init = init;
		if (settings !== undefined) mergedServer.settings = settings;
		merged[id] = mergedServer;
	}
	return merged;
}

function mergeObject<T extends Record<string, unknown>>(global: T | undefined, project: T | undefined): T | undefined {
	if (global === undefined) return project;
	if (project === undefined) return global;
	return { ...global, ...project };
}

function mergeJsonValue(global: LspJsonValue | undefined, project: LspJsonValue | undefined): LspJsonValue | undefined {
	if (project === undefined) return global;
	if (isJsonObject(global) && isJsonObject(project)) {
		const merged: Record<string, LspJsonValue> = { ...global };
		for (const [key, value] of Object.entries(project)) merged[key] = mergeJsonValue(global[key], value) ?? null;
		return merged;
	}
	return project;
}

function isJsonObject(value: LspJsonValue | undefined): value is { [key: string]: LspJsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function materializeConfig(raw: CompleteLspConfig): LspConfig {
	return {
		enabled: raw.enabled,
		exclude_paths: raw.exclude_paths.map(normalizeExcludePath),
		startup_timeout_ms: raw.startup_timeout_ms,
		request_timeout_ms: raw.request_timeout_ms,
		idle_timeout_ms: raw.idle_timeout_ms,
		max_open_documents: raw.max_open_documents,
		diagnostics: { ...raw.diagnostics },
		read: { ...raw.read },
		grep: { ...raw.grep },
		servers: normalizeServers(raw.servers),
	};
}

export function normalizeExcludePath(input: string): string {
	return path.resolve(expandHomePath(input));
}

function normalizeServers(servers: NonNullable<RawLspConfig["servers"]>): LspServerConfig[] {
	const entries = Object.entries(servers);
	if (entries.length > 50) throw new LspConfigError("LSP config cannot define more than 50 servers");
	const normalized = entries.map(([id, server]) => ({
		id,
		enabled: server.enabled ?? true,
		fallback: server.fallback ?? false,
		transport: normalizeTransport(id, server),
		routes: normalizeLanguages(id, server.languages),
		...(server.init !== undefined ? { initializationOptions: server.init } : {}),
		...(server.settings !== undefined ? { settings: server.settings } : {}),
	}));
	try {
		for (const server of normalized) validateServerRoutes(server);
	} catch (error) {
		throw new LspConfigError(error instanceof Error ? error.message : String(error));
	}
	return normalized;
}

function normalizeTransport(id: string, server: RawLspServer): LspTransport {
	if (server.command !== undefined && server.tcp !== undefined) {
		throw new LspConfigError(`LSP server "${id}" cannot combine command with tcp`);
	}
	if (server.command !== undefined) {
		const [command, ...args] = server.command;
		return { type: "stdio", command, args };
	}
	if (server.tcp !== undefined) return { type: "tcp", host: server.tcp.host, port: server.tcp.port };
	throw new LspConfigError(`LSP server "${id}" is missing command or tcp`);
}

function normalizeLanguages(serverId: string, input: Record<string, RawSelectors>): LspLanguageRoute[] {
	const routes = Object.entries(input).map(([languageId, value]) => ({
		languageId,
		selectors: typeof value === "string" ? [value] : value,
	}));
	const selectorCount = routes.reduce((total, route) => total + route.selectors.length, 0);
	if (selectorCount === 0) throw new LspConfigError(`LSP server "${serverId}" must define at least one file selector`);
	if (selectorCount > 64) throw new LspConfigError(`LSP server "${serverId}" cannot define more than 64 file selectors`);
	return routes;
}

function createError(message: string, details?: Record<string, unknown>): LspConfigError {
	return new LspConfigError(message, details);
}

const loadValidator = createSchemaValidator({ schemaPath: SCHEMA_PATH, label: "lsp", createError });
const loadCompleteValidator = createCompleteSchemaValidator({ schemaPath: SCHEMA_PATH, label: "lsp", createError });
