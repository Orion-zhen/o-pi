import ipaddr from "ipaddr.js";
import { stat } from "node:fs/promises";

import { agentConfigPath, agentPath, agentSchemaPath, createSchemaValidator, readOptionalJsoncConfigWithSchema } from "../config-loader.js";
import { guardPublicHttpUrlLiteral } from "../safety/url-guard.js";
import { normalizeDomains } from "./search-providers/query.js";
import type { WebToolsConfig } from "./types.js";

const CONFIG_PATH_ENV = "PI_WEB_TOOLS_CONFIG";
const COOKIES_PATH_ENV = "PI_WEB_TOOLS_COOKIES";
const MAX_STABLE_READ_ATTEMPTS = 3;

const defaultConfig: WebToolsConfig = {
	network: {
		fake_ip_ranges: [],
	},
	websearch: {
		default_results: 8,
		cache_ttl_seconds: 300,
		negative_cache_ttl_seconds: 30,
		total_deadline_seconds: 20,
		include_domains: [],
		exclude_domains: [],
		brave_api: {
			enabled: true,
			endpoint: "https://api.search.brave.com/res/v1/web/search",
			api_key: "$BRAVE_SEARCH_API_KEY",
			timeout_seconds: 8,
			response_bytes: 2_097_152,
			extra_snippets: false,
		},
		exa_api: {
			enabled: true,
			endpoint: "https://api.exa.ai/search",
			api_key: "$EXA_API_KEY",
			timeout_seconds: 10,
			response_bytes: 2_097_152,
			highlight_chars: 600,
		},
		tavily: {
			enabled: true,
			endpoint: "https://api.tavily.com/search",
			api_key: "$TAVILY_API_KEY",
			timeout_seconds: 10,
			response_bytes: 2_097_152,
		},
		duckduckgo_html: {
			enabled: true,
			timeout_seconds: 15,
			user_agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			region: "wt-wt",
			response_bytes: 2_097_152,
			min_interval_seconds: 15,
			blocked_cooldown_seconds: 600,
		},
	},
	webfetch: {
		timeout_seconds: 30,
		max_redirects: 5,
		user_agent: "pi-webfetch/1.0",
		readability: {
			char_threshold: 500,
		},
		media: {
			mode: "auto",
			response_bytes: 5_242_880,
		},
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

export class WebToolsConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "WebToolsConfigError";
	}
}

interface ConfigCacheEntry {
	fingerprint: string;
	config: WebToolsConfig;
}

const configCache = new Map<string, ConfigCacheEntry>();
const pendingConfigs = new Map<string, Promise<ConfigCacheEntry>>();

/** 读取 Web 工具 JSONC 配置；配置错误直接失败，避免凭据或网络策略静默降级。 */
export async function loadWebToolsConfig(): Promise<WebToolsConfig> {
	const configPath = resolveConfigPath();
	const fingerprint = await configFingerprint(configPath);
	const cached = configCache.get(configPath);
	if (cached?.fingerprint === fingerprint) return structuredClone(cached.config);

	const pendingKey = `${configPath}\0${fingerprint}`;
	let pending = pendingConfigs.get(pendingKey);
	if (pending === undefined) {
		pending = loadStableConfig(configPath, fingerprint);
		pendingConfigs.set(pendingKey, pending);
	}
	try {
		const loaded = await pending;
		configCache.set(configPath, loaded);
		return structuredClone(loaded.config);
	} finally {
		if (pendingConfigs.get(pendingKey) === pending) pendingConfigs.delete(pendingKey);
	}
}

export function clearWebToolsConfigCacheForTests(): void {
	configCache.clear();
	pendingConfigs.clear();
}

async function loadStableConfig(configPath: string, initialFingerprint: string): Promise<ConfigCacheEntry> {
	let fingerprint = initialFingerprint;
	for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
		const config = await loadConfigFile(configPath);
		const currentFingerprint = await configFingerprint(configPath);
		if (currentFingerprint === fingerprint) return { fingerprint: currentFingerprint, config };
		fingerprint = currentFingerprint;
	}
	throw new WebToolsConfigError("web-tools config changed while being read.", { path: configPath });
}

async function loadConfigFile(configPath: string): Promise<WebToolsConfig> {
	const parsed = await readOptionalJsoncConfigWithSchema({
		path: configPath,
		label: "web-tools",
		loadValidator,
		createError: (message, details) => new WebToolsConfigError(message, details),
	});
	if (parsed === undefined) return defaultWebToolsConfig();
	return mergeConfig(parsed as RawWebToolsConfig);
}

async function configFingerprint(configPath: string): Promise<string> {
	try {
		const info = await stat(configPath);
		return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "missing";
		return "unreadable";
	}
}

export function defaultWebToolsConfig(): WebToolsConfig {
	return structuredClone(defaultConfig);
}

export function defaultCookiePath(): string {
	return process.env[COOKIES_PATH_ENV] ?? agentPath("cookies.txt");
}

interface RawWebToolsConfig {
	network?: Partial<WebToolsConfig["network"]>;
	websearch?: {
		default_results?: number;
		cache_ttl_seconds?: number;
		negative_cache_ttl_seconds?: number;
		total_deadline_seconds?: number;
		include_domains?: string[];
		exclude_domains?: string[];
		brave_api?: Partial<WebToolsConfig["websearch"]["brave_api"]>;
		exa_api?: Partial<WebToolsConfig["websearch"]["exa_api"]>;
		tavily?: Partial<WebToolsConfig["websearch"]["tavily"]>;
		duckduckgo_html?: Partial<WebToolsConfig["websearch"]["duckduckgo_html"]>;
	};
	webfetch?: {
		timeout_seconds?: number;
		max_redirects?: number;
		user_agent?: string;
		readability?: Partial<WebToolsConfig["webfetch"]["readability"]>;
		media?: Partial<WebToolsConfig["webfetch"]["media"]>;
		limits?: Partial<WebToolsConfig["webfetch"]["limits"]>;
		cookies?: Partial<WebToolsConfig["webfetch"]["cookies"]>;
	};
}

function mergeConfig(raw: RawWebToolsConfig): WebToolsConfig {
	const merged: WebToolsConfig = {
		network: {
			fake_ip_ranges: raw.network?.fake_ip_ranges ?? [...defaultConfig.network.fake_ip_ranges],
		},
		websearch: {
			default_results: raw.websearch?.default_results ?? defaultConfig.websearch.default_results,
			cache_ttl_seconds: raw.websearch?.cache_ttl_seconds ?? defaultConfig.websearch.cache_ttl_seconds,
			negative_cache_ttl_seconds: raw.websearch?.negative_cache_ttl_seconds ?? defaultConfig.websearch.negative_cache_ttl_seconds,
			total_deadline_seconds: raw.websearch?.total_deadline_seconds ?? defaultConfig.websearch.total_deadline_seconds,
			include_domains: normalizeDomains(raw.websearch?.include_domains ?? defaultConfig.websearch.include_domains),
			exclude_domains: normalizeDomains(raw.websearch?.exclude_domains ?? defaultConfig.websearch.exclude_domains),
			brave_api: {
				enabled: raw.websearch?.brave_api?.enabled ?? defaultConfig.websearch.brave_api.enabled,
				endpoint: raw.websearch?.brave_api?.endpoint ?? defaultConfig.websearch.brave_api.endpoint,
				api_key: raw.websearch?.brave_api?.api_key ?? defaultConfig.websearch.brave_api.api_key,
				timeout_seconds: raw.websearch?.brave_api?.timeout_seconds ?? defaultConfig.websearch.brave_api.timeout_seconds,
				response_bytes: raw.websearch?.brave_api?.response_bytes ?? defaultConfig.websearch.brave_api.response_bytes,
				extra_snippets: raw.websearch?.brave_api?.extra_snippets ?? defaultConfig.websearch.brave_api.extra_snippets,
			},
			exa_api: {
				enabled: raw.websearch?.exa_api?.enabled ?? defaultConfig.websearch.exa_api.enabled,
				endpoint: raw.websearch?.exa_api?.endpoint ?? defaultConfig.websearch.exa_api.endpoint,
				api_key: raw.websearch?.exa_api?.api_key ?? defaultConfig.websearch.exa_api.api_key,
				timeout_seconds: raw.websearch?.exa_api?.timeout_seconds ?? defaultConfig.websearch.exa_api.timeout_seconds,
				response_bytes: raw.websearch?.exa_api?.response_bytes ?? defaultConfig.websearch.exa_api.response_bytes,
				highlight_chars: raw.websearch?.exa_api?.highlight_chars ?? defaultConfig.websearch.exa_api.highlight_chars,
			},
			tavily: {
				enabled: raw.websearch?.tavily?.enabled ?? defaultConfig.websearch.tavily.enabled,
				endpoint: raw.websearch?.tavily?.endpoint ?? defaultConfig.websearch.tavily.endpoint,
				api_key: raw.websearch?.tavily?.api_key ?? defaultConfig.websearch.tavily.api_key,
				timeout_seconds: raw.websearch?.tavily?.timeout_seconds ?? defaultConfig.websearch.tavily.timeout_seconds,
				response_bytes: raw.websearch?.tavily?.response_bytes ?? defaultConfig.websearch.tavily.response_bytes,
			},
			duckduckgo_html: {
				enabled: raw.websearch?.duckduckgo_html?.enabled ?? defaultConfig.websearch.duckduckgo_html.enabled,
				timeout_seconds: raw.websearch?.duckduckgo_html?.timeout_seconds ?? defaultConfig.websearch.duckduckgo_html.timeout_seconds,
				user_agent: raw.websearch?.duckduckgo_html?.user_agent ?? defaultConfig.websearch.duckduckgo_html.user_agent,
				region: raw.websearch?.duckduckgo_html?.region ?? defaultConfig.websearch.duckduckgo_html.region,
				response_bytes: raw.websearch?.duckduckgo_html?.response_bytes ?? defaultConfig.websearch.duckduckgo_html.response_bytes,
				min_interval_seconds: raw.websearch?.duckduckgo_html?.min_interval_seconds ?? defaultConfig.websearch.duckduckgo_html.min_interval_seconds,
				blocked_cooldown_seconds: raw.websearch?.duckduckgo_html?.blocked_cooldown_seconds ?? defaultConfig.websearch.duckduckgo_html.blocked_cooldown_seconds,
			},
		},
		webfetch: {
			timeout_seconds: raw.webfetch?.timeout_seconds ?? defaultConfig.webfetch.timeout_seconds,
			max_redirects: raw.webfetch?.max_redirects ?? defaultConfig.webfetch.max_redirects,
			user_agent: raw.webfetch?.user_agent ?? defaultConfig.webfetch.user_agent,
			readability: {
				char_threshold: raw.webfetch?.readability?.char_threshold ?? defaultConfig.webfetch.readability.char_threshold,
			},
			media: {
				mode: raw.webfetch?.media?.mode ?? defaultConfig.webfetch.media.mode,
				response_bytes: raw.webfetch?.media?.response_bytes ?? defaultConfig.webfetch.media.response_bytes,
			},
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
	if (merged.websearch.include_domains.some((domain) => merged.websearch.exclude_domains.includes(domain))) {
		throw new WebToolsConfigError("websearch include_domains and exclude_domains must not overlap.");
	}
	validateFakeIpRanges(merged.network.fake_ip_ranges);
	validateProviderUrl("brave_api", merged.websearch.brave_api.endpoint);
	validateProviderUrl("exa_api", merged.websearch.exa_api.endpoint);
	validateProviderUrl("tavily", merged.websearch.tavily.endpoint);
	return merged;
}

function validateProviderUrl(provider: string, value: string): void {
	try {
		guardPublicHttpUrlLiteral(value);
	} catch (error) {
		throw new WebToolsConfigError(`${provider}.endpoint is not an allowed public HTTP URL.`, {
			error: error instanceof Error ? error.message : String(error),
		});
	}
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

const loadValidator = createSchemaValidator({
	schemaPath: agentSchemaPath("web-tools.schema.json"),
	label: "web-tools",
	createError: (message, details) => new WebToolsConfigError(message, details),
});

function resolveConfigPath(): string {
	return agentConfigPath("web-tools.jsonc", CONFIG_PATH_ENV);
}
