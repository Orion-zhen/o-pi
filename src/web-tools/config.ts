import ipaddr from "ipaddr.js";
import {
	CONFIG_DEFINITIONS,
	agentPath,
	agentSchemaPath,
	configLayerFingerprint,
	createCompleteSchemaValidator,
	createSchemaValidator,
	defaultAgentConfigPath,
	loadValidatedMergedConfig,
	readDefaultJsoncConfigSync,
	resolveConfigLayerPaths,
} from "../config-loader.js";
import type { WebToolsConfig } from "./core/types.js";
import { guardPublicHttpUrlLiteral } from "./network/url-guard.js";
import { normalizeDomains } from "./search-providers/query.js";

const COOKIES_PATH_ENV = "PI_WEB_TOOLS_COOKIES";
const SCHEMA_PATH = agentSchemaPath("web-tools.schema.json");
const OPTIONAL_COMPLETE_PROPERTIES = ["network.proxy"] as const;
const DEFAULT_PROXY_CONFIG: WebToolsConfig["network"]["proxy"] = {
	enabled: false,
	http_proxy: "",
	https_proxy: "",
	socks5_proxy: "",
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
	const paths = resolveConfigLayerPaths(CONFIG_DEFINITIONS.webTools, process.cwd());
	const cacheKey = paths.map((source) => source.path).join("\0");
	const fingerprint = await configLayerFingerprint(paths);
	const cached = configCache.get(cacheKey);
	if (cached?.fingerprint === fingerprint) return structuredClone(cached.config);

	const pendingKey = `${cacheKey}\0${fingerprint}`;
	let pending = pendingConfigs.get(pendingKey);
	if (pending === undefined) {
		pending = loadConfigFile();
		pendingConfigs.set(pendingKey, pending);
	}
	try {
		const loaded = await pending;
		configCache.set(cacheKey, loaded);
		return structuredClone(loaded.config);
	} finally {
		if (pendingConfigs.get(pendingKey) === pending) pendingConfigs.delete(pendingKey);
	}
}

export function clearWebToolsConfigCacheForTests(): void {
	configCache.clear();
	pendingConfigs.clear();
}

async function loadConfigFile(): Promise<ConfigCacheEntry> {
	const loaded = await loadValidatedMergedConfig(
		CONFIG_DEFINITIONS.webTools, process.cwd(), createError, { partial: loadValidator, complete: loadCompleteValidator },
	);
	return { fingerprint: loaded.fingerprint, config: materializeConfig(loaded.merged as CompleteWebToolsConfig) };
}

export function defaultWebToolsConfig(): WebToolsConfig {
	return materializeConfig(readDefaultJsoncConfigSync({
		configPath: defaultAgentConfigPath("web-tools.jsonc"),
		schemaPath: SCHEMA_PATH,
		label: "web-tools",
		createError,
		optionalCompleteProperties: OPTIONAL_COMPLETE_PROPERTIES,
	}) as CompleteWebToolsConfig);
}

export function defaultCookiePath(): string {
	return process.env[COOKIES_PATH_ENV] ?? agentPath("cookies.txt");
}

interface RawWebToolsConfig {
	network?: {
		proxy?: Partial<WebToolsConfig["network"]["proxy"]>;
		fake_ip_ranges?: string[];
	};
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

interface CompleteWebToolsConfig extends Required<RawWebToolsConfig> {
	network: {
		proxy?: Partial<WebToolsConfig["network"]["proxy"]>;
		fake_ip_ranges: string[];
	};
	websearch: WebToolsConfig["websearch"];
	webfetch: WebToolsConfig["webfetch"];
}

function materializeConfig(raw: CompleteWebToolsConfig): WebToolsConfig {
	const config: WebToolsConfig = {
		network: {
			proxy: { ...DEFAULT_PROXY_CONFIG, ...raw.network.proxy },
			fake_ip_ranges: structuredClone(raw.network.fake_ip_ranges),
		},
		websearch: structuredClone(raw.websearch),
		webfetch: structuredClone(raw.webfetch),
	};
	config.websearch.include_domains = normalizeDomains(config.websearch.include_domains);
	config.websearch.exclude_domains = normalizeDomains(config.websearch.exclude_domains);
	if (config.webfetch.limits.default_output_chars > config.webfetch.limits.max_output_chars) {
		throw new WebToolsConfigError("default_output_chars must not exceed max_output_chars.");
	}
	if (config.websearch.include_domains.some((domain) => config.websearch.exclude_domains.includes(domain))) {
		throw new WebToolsConfigError("websearch include_domains and exclude_domains must not overlap.");
	}
	validateProxyConfig(config.network.proxy);
	validateFakeIpRanges(config.network.fake_ip_ranges);
	validateProviderUrl("brave_api", config.websearch.brave_api.endpoint);
	validateProviderUrl("exa_api", config.websearch.exa_api.endpoint);
	validateProviderUrl("tavily", config.websearch.tavily.endpoint);
	return config;
}

function validateProxyConfig(proxy: WebToolsConfig["network"]["proxy"]): void {
	const endpoints = [
		["http_proxy", proxy.http_proxy, new Set(["http:", "https:"])],
		["https_proxy", proxy.https_proxy, new Set(["http:", "https:"])],
		["socks5_proxy", proxy.socks5_proxy, new Set(["socks5:"])],
	] as const;
	if (proxy.enabled && endpoints.every(([, value]) => value === "")) {
		throw new WebToolsConfigError("network.proxy.enabled requires at least one proxy endpoint.");
	}
	for (const [field, value, protocols] of endpoints) validateProxyUrl(field, value, protocols);
}

function validateProxyUrl(field: string, value: string, protocols: ReadonlySet<string>): void {
	if (value === "") return;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new WebToolsConfigError(`network.proxy.${field} must be a valid proxy URL.`);
	}
	if (
		!protocols.has(url.protocol)
		|| url.hostname === ""
		|| !isValidProxyPort(url.port)
		|| (url.pathname !== "" && url.pathname !== "/")
		|| url.search !== ""
		|| url.hash !== ""
	) {
		throw new WebToolsConfigError(`network.proxy.${field} must be a valid proxy URL.`);
	}
}

function isValidProxyPort(port: string): boolean {
	if (port === "") return true;
	const value = Number(port);
	return Number.isInteger(value) && value >= 1 && value <= 65_535;
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

function createError(message: string, details?: Record<string, unknown>): WebToolsConfigError {
	return new WebToolsConfigError(message, details);
}

const loadValidator = createSchemaValidator({ schemaPath: SCHEMA_PATH, label: "web-tools", createError });
const loadCompleteValidator = createCompleteSchemaValidator({
	schemaPath: SCHEMA_PATH,
	label: "web-tools",
	createError,
	optionalCompleteProperties: OPTIONAL_COMPLETE_PROPERTIES,
});
