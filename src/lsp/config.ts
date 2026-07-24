import path from "node:path";

import { agentConfigPath, agentSchemaPath, createSchemaValidator, expandHomePath, readOptionalJsoncConfigWithSchema } from "../config-loader.js";
import { LspServerRegistry } from "./registry.js";
import type { LoadedLspConfig, LspConfig, LspServerConfig, LspTransport } from "./types.js";

const CONFIG_PATH_ENV = "PI_LSP_CONFIG";

const defaultServers: LspServerConfig[] = [
	stdioServer(
		"typescript",
		"typescript-language-server",
		["--stdio"],
		[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		{
			".ts": "typescript",
			".tsx": "typescriptreact",
			".js": "javascript",
			".jsx": "javascriptreact",
			".mjs": "javascript",
			".cjs": "javascript",
		},
	),
	stdioServer("python", "pyright-langserver", ["--stdio"], [".py", ".pyi"], {}, "python"),
	stdioServer("rust", "rust-analyzer", [], [".rs"], {}, "rust"),
	stdioServer("yaml", "yaml-language-server", ["--stdio"], [".yaml", ".yml"], {}, "yaml"),
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
	servers?: Array<{
		id: string;
		enabled?: boolean;
		command?: string;
		args?: string[];
		transport?: {
			type: "stdio";
			command: string;
			args?: string[];
		} | {
			type: "tcp";
			host: string;
			port: number;
		};
		language_id?: string;
		language_ids?: Record<string, string>;
		extensions: string[];
		initialization_options?: Record<string, unknown>;
	}>;
}

/** 读取用户级 LSP JSONC 配置；不会读取项目级配置，避免项目配置执行任意本地 command。 */
export async function loadLspConfig(): Promise<LoadedLspConfig> {
	const configPath = resolveLspConfigPath();
	const parsed = await readOptionalJsoncConfigWithSchema({
		path: configPath,
		label: "lsp",
		loadValidator,
		createError: (message, details) => new LspConfigError(message, details),
	});
	if (parsed === undefined) return { path: configPath, config: defaultLspConfig() };
	return { path: configPath, config: mergeConfig(parsed as RawLspConfig) };
}

export function defaultLspConfig(): LspConfig {
	return structuredClone(defaultConfig);
}

export function resolveLspConfigPath(): string {
	return agentConfigPath("lsp.jsonc", CONFIG_PATH_ENV);
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
	command: string,
	args: string[],
	extensions: string[],
	language_ids: Record<string, string>,
	language_id?: string,
): LspServerConfig {
	return {
		id,
		enabled: true,
		transport: { type: "stdio", command, args },
		language_ids,
		extensions,
		...(language_id !== undefined ? { language_id } : {}),
	};
}

function normalizeServers(servers: NonNullable<RawLspConfig["servers"]>): LspServerConfig[] {
	const normalized = servers.map((server) => {
		const extensions = [...new Set(server.extensions.map(normalizeExtension))];
		const transport = normalizeTransport(server);
		return {
			id: server.id,
			enabled: server.enabled ?? true,
			transport,
			language_ids: normalizeLanguageIds(server.id, server.language_ids ?? {}, extensions),
			extensions,
			...(server.language_id !== undefined ? { language_id: server.language_id } : {}),
			...(server.initialization_options !== undefined ? { initialization_options: server.initialization_options } : {}),
		};
	});
	try {
		new LspServerRegistry(normalized);
	} catch (error) {
		throw new LspConfigError(error instanceof Error ? error.message : String(error));
	}
	return normalized;
}

function normalizeTransport(server: NonNullable<RawLspConfig["servers"]>[number]): LspTransport {
	if (server.transport !== undefined) {
		if (server.command !== undefined || server.args !== undefined) {
			throw new LspConfigError(`LSP server "${server.id}" cannot combine transport with command or args`);
		}
		return server.transport.type === "stdio"
			? { type: "stdio", command: server.transport.command, args: server.transport.args ?? [] }
			: { type: "tcp", host: server.transport.host, port: server.transport.port };
	}
	if (server.command === undefined) throw new LspConfigError(`LSP server "${server.id}" is missing a transport`);
	return { type: "stdio", command: server.command, args: server.args ?? [] };
}

function normalizeExtension(extension: string): string {
	return extension.toLowerCase();
}

function normalizeLanguageIds(serverId: string, input: Record<string, string>, extensions: readonly string[]): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [rawExtension, languageId] of Object.entries(input)) {
		const extension = normalizeExtension(rawExtension);
		if (!extensions.includes(extension)) {
			throw new LspConfigError(`LSP server "${serverId}" language_ids extension "${rawExtension}" is not listed in extensions`);
		}
		if (normalized[extension] !== undefined) {
			throw new LspConfigError(`LSP server "${serverId}" has duplicate language_ids extension "${extension}"`);
		}
		normalized[extension] = languageId;
	}
	return normalized;
}

const loadValidator = createSchemaValidator({
	schemaPath: agentSchemaPath("lsp.schema.json"),
	label: "lsp",
	createError: (message, details) => new LspConfigError(message, details),
});
