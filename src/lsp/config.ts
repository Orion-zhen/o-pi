import path from "node:path";

import {
	agentConfigPath,
	agentSchemaPath,
	createSchemaValidator,
	expandHomePath,
	projectAgentConfigPath,
	readOptionalJsoncConfig,
	readOptionalJsoncConfigWithSchema,
} from "../config-loader.js";
import { LspServerRegistry } from "./registry.js";
import type { LoadedLspConfig, LspConfig, LspJsonValue, LspLanguageRoute, LspServerConfig, LspTransport } from "./types.js";

const CONFIG_PATH_ENV = "PI_LSP_CONFIG";
const PROJECT_CONFIG_ENV = "PI_LSP_PROJECT_CONFIG";
const PROJECT_ROOT_ENV = "PI_LSP_PROJECT_ROOT";

type RawSelectors = string | string[];

const defaultServers: LspServerConfig[] = [
	stdioServer("typescript", ["typescript-language-server", "--stdio"], {
		typescript: "*.ts",
		typescriptreact: "*.tsx",
		javascript: "*.{js,mjs,cjs}",
		javascriptreact: "*.jsx",
	}),
	stdioServer("python", ["pyright-langserver", "--stdio"], { python: "*.{py,pyi}" }),
	stdioServer("rust", ["rust-analyzer"], { rust: "*.rs" }),
	stdioServer("yaml", ["yaml-language-server", "--stdio"], { yaml: "*.{yaml,yml}" }, true),
];

const defaultConfig: LspConfig = {
	enabled: true,
	exclude_paths: [],
	startup_timeout_ms: 8000,
	request_timeout_ms: 5000,
	idle_timeout_ms: 300000,
	max_restarts: 2,
	max_open_documents: 64,
	diagnostics: {
		enabled: true,
		max_wait_ms: 3000,
		settle_ms: 150,
		max_items: 8,
		max_related_locations: 2,
		min_severity: "warning",
	},
	read: {
		outline: true,
		max_symbols: 40,
	},
	grep: {
		workspace_symbols: true,
		references: false,
		max_symbols: 20,
		max_references: 20,
	},
	servers: defaultServers,
};

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
	max_restarts?: number;
	max_open_documents?: number;
	diagnostics?: Partial<LspConfig["diagnostics"]>;
	read?: Partial<LspConfig["read"]>;
	grep?: Partial<LspConfig["grep"]>;
	servers?: Record<string, RawLspServer>;
}

/** 读取全局与项目级 LSP JSONC 配置；项目配置按字段覆盖全局配置。 */
export async function loadLspConfig(cwd = process.cwd()): Promise<LoadedLspConfig> {
	const globalPath = resolveLspConfigPath();
	const globalRaw = await readGlobalConfig(globalPath);
	const projectPath = resolveProjectLspConfigPath(cwd);
	const projectRaw = projectPath === undefined ? undefined : await readProjectConfig(projectPath);
	const raw = mergeRawConfig(globalRaw, projectRaw);
	const configPath = projectRaw === undefined ? globalPath : projectPath ?? globalPath;
	if (projectRaw !== undefined) await validateRawConfig(raw, configPath);
	return { path: configPath, config: mergeConfig(raw) };
}

export function defaultLspConfig(): LspConfig {
	return structuredClone(defaultConfig);
}

export function resolveLspConfigPath(): string {
	return agentConfigPath("lsp.jsonc", CONFIG_PATH_ENV);
}

export function resolveProjectLspConfigPath(cwd: string): string | undefined {
	return projectAgentConfigPath(cwd, "lsp.jsonc", PROJECT_CONFIG_ENV, PROJECT_ROOT_ENV);
}

async function readGlobalConfig(configPath: string): Promise<RawLspConfig | undefined> {
	const parsed = await readOptionalJsoncConfigWithSchema({
		path: configPath,
		label: "lsp",
		loadValidator,
		createError: (message, details) => new LspConfigError(message, details),
	});
	return parsed as RawLspConfig | undefined;
}

async function readProjectConfig(configPath: string): Promise<RawLspConfig | undefined> {
	const parsed = await readOptionalJsoncConfig({
		path: configPath,
		label: "lsp",
		createError: (message, details) => new LspConfigError(message, details),
	});
	return parsed as RawLspConfig | undefined;
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

function mergeRawConfig(global: RawLspConfig | undefined, project: RawLspConfig | undefined): RawLspConfig {
	if (global === undefined) return project ?? {};
	if (project === undefined) return global;
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

function mergeConfig(raw: RawLspConfig): LspConfig {
	const base = defaultLspConfig();
	return {
		enabled: raw.enabled ?? base.enabled,
		exclude_paths: (raw.exclude_paths ?? base.exclude_paths).map(normalizeExcludePath),
		startup_timeout_ms: raw.startup_timeout_ms ?? base.startup_timeout_ms,
		request_timeout_ms: raw.request_timeout_ms ?? base.request_timeout_ms,
		idle_timeout_ms: raw.idle_timeout_ms ?? base.idle_timeout_ms,
		max_restarts: raw.max_restarts ?? base.max_restarts,
		max_open_documents: raw.max_open_documents ?? base.max_open_documents,
		diagnostics: {
			enabled: raw.diagnostics?.enabled ?? base.diagnostics.enabled,
			max_wait_ms: raw.diagnostics?.max_wait_ms ?? base.diagnostics.max_wait_ms,
			settle_ms: raw.diagnostics?.settle_ms ?? base.diagnostics.settle_ms,
			max_items: raw.diagnostics?.max_items ?? base.diagnostics.max_items,
			max_related_locations: raw.diagnostics?.max_related_locations ?? base.diagnostics.max_related_locations,
			min_severity: raw.diagnostics?.min_severity ?? base.diagnostics.min_severity,
		},
		read: {
			outline: raw.read?.outline ?? base.read.outline,
			max_symbols: raw.read?.max_symbols ?? base.read.max_symbols,
		},
		grep: {
			workspace_symbols: raw.grep?.workspace_symbols ?? base.grep.workspace_symbols,
			references: raw.grep?.references ?? base.grep.references,
			max_symbols: raw.grep?.max_symbols ?? base.grep.max_symbols,
			max_references: raw.grep?.max_references ?? base.grep.max_references,
		},
		servers: raw.servers === undefined ? base.servers : normalizeServers(raw.servers),
	};
}

export function normalizeExcludePath(input: string): string {
	return path.resolve(expandHomePath(input));
}

function stdioServer(
	id: string,
	command: [string, ...string[]],
	languages: Record<string, RawSelectors>,
	fallback = false,
): LspServerConfig {
	const [executable, ...args] = command;
	return {
		id,
		enabled: true,
		fallback,
		transport: { type: "stdio", command: executable, args },
		routes: normalizeLanguages(id, languages),
	};
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
		new LspServerRegistry(normalized);
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
		selectors: [...new Set(typeof value === "string" ? [value] : value)],
	}));
	const selectorCount = routes.reduce((total, route) => total + route.selectors.length, 0);
	if (selectorCount === 0) throw new LspConfigError(`LSP server "${serverId}" must define at least one file selector`);
	if (selectorCount > 64) throw new LspConfigError(`LSP server "${serverId}" cannot define more than 64 file selectors`);
	return routes;
}

const loadValidator = createSchemaValidator({
	schemaPath: agentSchemaPath("lsp.schema.json"),
	label: "lsp",
	createError: (message, details) => new LspConfigError(message, details),
});
