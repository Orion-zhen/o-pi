import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ValidateFunction } from "ajv/dist/ajv.js";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import type { LoadedLspConfig, LspConfig, LspServerConfig } from "./types.js";

const CONFIG_PATH_ENV = "PI_LSP_CONFIG";

const defaultServers: LspServerConfig[] = [
	{
		id: "typescript",
		enabled: true,
		command: "typescript-language-server",
		args: ["--stdio"],
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
	},
	{
		id: "python",
		enabled: true,
		command: "pyright-langserver",
		args: ["--stdio"],
		extensions: [".py", ".pyi"],
	},
	{
		id: "rust",
		enabled: true,
		command: "rust-analyzer",
		args: [],
		extensions: [".rs"],
	},
];

const defaultConfig: LspConfig = {
	version: 1,
	enabled: true,
	exclude_paths: [],
	startup_timeout_ms: 8000,
	request_timeout_ms: 5000,
	idle_timeout_ms: 300000,
	max_restarts: 2,
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

let compiledValidator: ValidateFunction | undefined;

/** LSP 配置读取、JSONC 解析或 schema 校验失败。 */
export class LspConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "LspConfigError";
	}
}

interface RawLspConfig {
	version: 1;
	enabled?: boolean;
	exclude_paths?: string[];
	startup_timeout_ms?: number;
	request_timeout_ms?: number;
	idle_timeout_ms?: number;
	max_restarts?: number;
	diagnostics?: Partial<LspConfig["diagnostics"]>;
	read?: Partial<LspConfig["read"]>;
	grep?: Partial<LspConfig["grep"]>;
	servers?: Array<{
		id: string;
		enabled?: boolean;
		command: string;
		args?: string[];
		extensions: string[];
		initialization_options?: Record<string, unknown>;
	}>;
}

/** 读取用户级 LSP JSONC 配置；不会读取项目级配置，避免项目配置执行任意本地 command。 */
export async function loadLspConfig(): Promise<LoadedLspConfig> {
	const configPath = resolveLspConfigPath();
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if (isNotFound(error)) return { path: configPath, config: defaultLspConfig() };
		throw new LspConfigError("lsp config cannot be read.", { path: configPath });
	}

	const parseErrors: ParseError[] = [];
	const parsed = parse(text, parseErrors, { allowTrailingComma: true });
	if (parseErrors.length > 0) {
		const first = parseErrors[0];
		throw new LspConfigError("lsp config is not valid JSONC.", {
			path: configPath,
			error: first ? printParseErrorCode(first.error) : "unknown",
			offset: first?.offset,
		});
	}

	const validator = await loadValidator();
	if (!validator(parsed)) {
		throw new LspConfigError("lsp config does not match schema.", { path: configPath, errors: validator.errors ?? [] });
	}

	return { path: configPath, config: mergeConfig(parsed as RawLspConfig) };
}

export function defaultLspConfig(): LspConfig {
	return {
		...defaultConfig,
		exclude_paths: [...defaultConfig.exclude_paths],
		diagnostics: { ...defaultConfig.diagnostics },
		read: { ...defaultConfig.read },
		grep: { ...defaultConfig.grep },
		servers: defaultConfig.servers.map((server) => ({ ...server, args: [...server.args], extensions: [...server.extensions] })),
	};
}

export function resolveLspConfigPath(): string {
	return process.env[CONFIG_PATH_ENV] ?? path.join(projectRoot(), "agent", "configs", "lsp.jsonc");
}

function mergeConfig(raw: RawLspConfig): LspConfig {
	const base = defaultLspConfig();
	return {
		version: 1,
		enabled: raw.enabled ?? base.enabled,
		exclude_paths: (raw.exclude_paths ?? base.exclude_paths).map(normalizeExcludePath),
		startup_timeout_ms: raw.startup_timeout_ms ?? base.startup_timeout_ms,
		request_timeout_ms: raw.request_timeout_ms ?? base.request_timeout_ms,
		idle_timeout_ms: raw.idle_timeout_ms ?? base.idle_timeout_ms,
		max_restarts: raw.max_restarts ?? base.max_restarts,
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
		servers: (raw.servers ?? base.servers).map((server) => ({
			id: server.id,
			enabled: server.enabled ?? true,
			command: server.command,
			args: server.args ?? [],
			extensions: server.extensions,
			...(server.initialization_options !== undefined ? { initialization_options: server.initialization_options } : {}),
		})),
	};
}

export function normalizeExcludePath(input: string): string {
	const expanded = input === "~" ? os.homedir() : input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
	return path.resolve(expanded);
}

async function loadValidator(): Promise<ValidateFunction> {
	if (compiledValidator !== undefined) return compiledValidator;
	const schemaPath = path.join(projectRoot(), "agent", "schemas", "lsp.schema.json");
	let schema: object;
	try {
		schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
	} catch {
		throw new LspConfigError("lsp schema cannot be read.", { path: schemaPath });
	}
	const ajv = new Ajv({ allErrors: true, strict: true, validateSchema: false });
	compiledValidator = ajv.compile(schema);
	return compiledValidator;
}

function projectRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
