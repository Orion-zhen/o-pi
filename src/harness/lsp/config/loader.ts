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
} from "../../config-loader.ts";
import { mergeConfigValues } from "../../config-values.ts";
import { validateServerRoutes } from "./routing.ts";
import type { LoadedLspConfig, LspConfig, LspJsonValue, LspLanguageRoute, LspServerConfig, LspTransport } from "../types.ts";

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

interface RawLspConfig extends Partial<Omit<LspConfig, "diagnostics" | "grep" | "servers">> {
	diagnostics?: Partial<LspConfig["diagnostics"]>;
	grep?: Partial<LspConfig["grep"]>;
	servers?: Record<string, RawLspServer>;
}

interface CompleteLspConfig extends Omit<LspConfig, "servers"> {
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

function mergeRawConfig(base: RawLspConfig, overlay: RawLspConfig): RawLspConfig {
	const merged = mergeConfigValues(base, overlay) as RawLspConfig;
	for (const [id, server] of Object.entries(overlay.servers ?? {})) {
		const target = merged.servers?.[id];
		// TCP 端点整体替换，不能从上一层补齐缺失的 host 或 port。
		if (target !== undefined && server.tcp !== undefined) target.tcp = server.tcp;
	}
	return merged;
}

function materializeConfig(raw: CompleteLspConfig): LspConfig {
	return {
		...raw,
		exclude_paths: raw.exclude_paths.map(normalizeExcludePath),
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
