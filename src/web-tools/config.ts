import ipaddr from "ipaddr.js";
import {
	CONFIG_DEFINITIONS,
	agentPath,
	agentSchemaPath,
	configLayerFingerprint,
	createCompleteSchemaValidator,
	createSchemaValidator,
	defaultAgentConfigPath,
	loadConfigLayers,
	mergeConfigValues,
	readDefaultJsoncConfigSync,
	resolveConfigLayerPaths,
	validateConfigValue,
} from "../config-loader.js";
import type { WebToolsConfig } from "./core/types.js";
import { guardPublicHttpUrlLiteral } from "./network/url-guard.js";
import { normalizeDomains } from "./search-providers/query.js";

const COOKIES_PATH_ENV = "PI_WEB_TOOLS_COOKIES";
const SCHEMA_PATH = agentSchemaPath("web-tools.schema.json");

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
	const loaded = await loadConfigLayers(CONFIG_DEFINITIONS.webTools, process.cwd(), createError);
	let merged: unknown = {};
	for (const layer of loaded.layers) {
		await validateConfigValue({
			path: layer.path,
			label: `web-tools ${layer.kind}`,
			value: layer.value,
			layer: layer.kind,
			loadValidator: layer.kind === "default" ? loadCompleteValidator : loadValidator,
			createError,
		});
		merged = mergeConfigValues(merged, layer.value);
	}
	return { fingerprint: loaded.fingerprint, config: materializeConfig(merged as CompleteWebToolsConfig) };
}

export function defaultWebToolsConfig(): WebToolsConfig {
	return materializeConfig(readDefaultJsoncConfigSync({
		configPath: defaultAgentConfigPath("web-tools.jsonc"),
		schemaPath: SCHEMA_PATH,
		label: "web-tools",
		createError,
	}) as CompleteWebToolsConfig);
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

interface CompleteWebToolsConfig extends Required<RawWebToolsConfig> {
	network: WebToolsConfig["network"];
	websearch: WebToolsConfig["websearch"];
	webfetch: WebToolsConfig["webfetch"];
}

function materializeConfig(raw: CompleteWebToolsConfig): WebToolsConfig {
	const config: WebToolsConfig = {
		network: structuredClone(raw.network),
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
	validateFakeIpRanges(config.network.fake_ip_ranges);
	validateProviderUrl("brave_api", config.websearch.brave_api.endpoint);
	validateProviderUrl("exa_api", config.websearch.exa_api.endpoint);
	validateProviderUrl("tavily", config.websearch.tavily.endpoint);
	return config;
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
const loadCompleteValidator = createCompleteSchemaValidator({ schemaPath: SCHEMA_PATH, label: "web-tools", createError });
