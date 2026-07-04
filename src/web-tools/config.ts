import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ValidateFunction } from "ajv/dist/ajv.js";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import ipaddr from "ipaddr.js";

import type { WebToolsConfig } from "./types.js";

const CONFIG_PATH_ENV = "PI_WEB_TOOLS_CONFIG";
const COOKIES_PATH_ENV = "PI_WEB_TOOLS_COOKIES";

const defaultConfig: WebToolsConfig = {
	version: 2,
	network: {
		fake_ip_ranges: [],
	},
	websearch: {
		timeout_seconds: 15,
		user_agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		region: "wt-wt",
		default_results: 8,
		response_bytes: 2_097_152,
	},
	webfetch: {
		timeout_seconds: 30,
		max_redirects: 5,
		user_agent: "pi-webfetch/1.0",
		limits: {
			response_bytes: 10_485_760,
			default_output_chars: 20_000,
			max_output_chars: 100_000,
		},
		cookies: {
			enabled: true,
			domains: [],
			confirmation: "session",
		},
	},
};

let compiledValidator: ValidateFunction | undefined;

export class WebToolsConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "WebToolsConfigError";
	}
}

/** 读取 Web 工具 JSONC 配置；配置错误直接失败，避免凭据或网络策略静默降级。 */
export async function loadWebToolsConfig(): Promise<WebToolsConfig> {
	const configPath = resolveConfigPath();
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if (isNotFound(error)) return defaultWebToolsConfig();
		throw new WebToolsConfigError("web-tools config cannot be read.", { path: configPath });
	}

	const parseErrors: ParseError[] = [];
	const parsed = parse(text, parseErrors, { allowTrailingComma: true });
	if (parseErrors.length > 0) {
		const first = parseErrors[0];
		throw new WebToolsConfigError("web-tools config is not valid JSONC.", {
			path: configPath,
			error: first ? printParseErrorCode(first.error) : "unknown",
			offset: first?.offset,
		});
	}

	const validator = await loadValidator();
	if (!validator(parsed)) {
		throw new WebToolsConfigError("web-tools config does not match schema.", {
			path: configPath,
			errors: validator.errors ?? [],
		});
	}

	return mergeConfig(parsed as RawWebToolsConfig);
}

export function defaultWebToolsConfig(): WebToolsConfig {
	return {
		version: 2,
		network: { fake_ip_ranges: [...defaultConfig.network.fake_ip_ranges] },
		websearch: { ...defaultConfig.websearch },
		webfetch: {
			timeout_seconds: defaultConfig.webfetch.timeout_seconds,
			max_redirects: defaultConfig.webfetch.max_redirects,
			user_agent: defaultConfig.webfetch.user_agent,
			limits: { ...defaultConfig.webfetch.limits },
			cookies: {
				enabled: defaultConfig.webfetch.cookies.enabled,
				domains: [...defaultConfig.webfetch.cookies.domains],
				confirmation: defaultConfig.webfetch.cookies.confirmation,
			},
		},
	};
}

export function defaultCookiePath(): string {
	return process.env[COOKIES_PATH_ENV] ?? path.join(projectRoot(), "agent", "cookies.txt");
}

interface RawWebToolsConfig {
	version: 2;
	network?: Partial<WebToolsConfig["network"]>;
	websearch?: Partial<WebToolsConfig["websearch"]>;
	webfetch?: {
		timeout_seconds?: number;
		max_redirects?: number;
		user_agent?: string;
		limits?: Partial<WebToolsConfig["webfetch"]["limits"]>;
		cookies?: Partial<WebToolsConfig["webfetch"]["cookies"]>;
	};
}

function mergeConfig(raw: RawWebToolsConfig): WebToolsConfig {
	const merged: WebToolsConfig = {
		version: 2,
		network: {
			fake_ip_ranges: raw.network?.fake_ip_ranges ?? [...defaultConfig.network.fake_ip_ranges],
		},
		websearch: {
			timeout_seconds: raw.websearch?.timeout_seconds ?? defaultConfig.websearch.timeout_seconds,
			user_agent: raw.websearch?.user_agent ?? defaultConfig.websearch.user_agent,
			region: raw.websearch?.region ?? defaultConfig.websearch.region,
			default_results: raw.websearch?.default_results ?? defaultConfig.websearch.default_results,
			response_bytes: raw.websearch?.response_bytes ?? defaultConfig.websearch.response_bytes,
		},
		webfetch: {
			timeout_seconds: raw.webfetch?.timeout_seconds ?? defaultConfig.webfetch.timeout_seconds,
			max_redirects: raw.webfetch?.max_redirects ?? defaultConfig.webfetch.max_redirects,
			user_agent: raw.webfetch?.user_agent ?? defaultConfig.webfetch.user_agent,
			limits: {
				response_bytes: raw.webfetch?.limits?.response_bytes ?? defaultConfig.webfetch.limits.response_bytes,
				default_output_chars: raw.webfetch?.limits?.default_output_chars ?? defaultConfig.webfetch.limits.default_output_chars,
				max_output_chars: raw.webfetch?.limits?.max_output_chars ?? defaultConfig.webfetch.limits.max_output_chars,
			},
			cookies: {
				enabled: raw.webfetch?.cookies?.enabled ?? defaultConfig.webfetch.cookies.enabled,
				domains: raw.webfetch?.cookies?.domains ?? [...defaultConfig.webfetch.cookies.domains],
				confirmation: raw.webfetch?.cookies?.confirmation ?? defaultConfig.webfetch.cookies.confirmation,
			},
		},
	};
	if (merged.webfetch.limits.default_output_chars > merged.webfetch.limits.max_output_chars) {
		throw new WebToolsConfigError("default_output_chars must not exceed max_output_chars.");
	}
	validateFakeIpRanges(merged.network.fake_ip_ranges);
	return merged;
}

function validateFakeIpRanges(ranges: string[]): void {
	const benchmark = ipaddr.parseCIDR("198.18.0.0/15");
	for (const range of ranges) {
		let parsed: [ipaddr.IPv4 | ipaddr.IPv6, number];
		try {
			parsed = ipaddr.parseCIDR(range);
		} catch {
			throw new WebToolsConfigError("fake_ip_ranges must contain valid CIDR ranges.");
		}
		if (parsed[0].kind() !== "ipv4" || !cidrInside(parsed, benchmark)) {
			throw new WebToolsConfigError("fake_ip_ranges only supports subnets inside 198.18.0.0/15.");
		}
	}
}

function cidrInside(child: [ipaddr.IPv4 | ipaddr.IPv6, number], parent: [ipaddr.IPv4 | ipaddr.IPv6, number]): boolean {
	if (child[0].kind() !== parent[0].kind() || child[1] < parent[1]) return false;
	return child[0].match(parent);
}

async function loadValidator(): Promise<ValidateFunction> {
	if (compiledValidator !== undefined) return compiledValidator;
	const schemaPath = path.join(projectRoot(), "agent", "schemas", "web-tools.schema.json");
	let schema: object;
	try {
		schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
	} catch {
		throw new WebToolsConfigError("web-tools schema cannot be read.", { path: schemaPath });
	}
	const ajv = new Ajv({ allErrors: true, strict: true, validateSchema: false });
	compiledValidator = ajv.compile(schema);
	return compiledValidator;
}

function resolveConfigPath(): string {
	return process.env[CONFIG_PATH_ENV] ?? path.join(projectRoot(), "agent", "configs", "web-tools.jsonc");
}

function projectRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
