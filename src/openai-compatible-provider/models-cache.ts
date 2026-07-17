import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { userCachePath } from "../config-loader.js";
import { fetchProviderModelsFromEndpoint, modelsEndpointUrl, type ResolveAutoModelsOptions } from "./models-endpoint.js";
import type { ModelConfig, ModelsJsoncConfig, ProviderConfig } from "./schema.js";

const CACHE_VERSION = 1;

export interface CachedProviderModels {
	source: string;
	models: ModelConfig[];
}

export interface ModelsDiscoveryCache {
	version: typeof CACHE_VERSION;
	providers: Record<string, CachedProviderModels>;
}

export interface ModelsRefreshFailure {
	providerId: string;
	error: unknown;
}

export interface ModelsRefreshResult {
	cache: ModelsDiscoveryCache;
	changed: boolean;
	updatedProviderIds: string[];
	failures: ModelsRefreshFailure[];
}

export interface RefreshModelsCacheOptions extends ResolveAutoModelsOptions {
	cachePath?: string;
}

export function defaultModelsCachePath(): string {
	return userCachePath("openai-compatible-provider", "models.json");
}

/** 读取扩展生成的公开模型元数据缓存；缺失或损坏时按空缓存处理。 */
export async function loadModelsDiscoveryCache(cachePath = defaultModelsCachePath()): Promise<ModelsDiscoveryCache> {
	let text: string;
	try {
		text = await readFile(cachePath, "utf8");
	} catch {
		return emptyCache();
	}

	try {
		return parseCache(JSON.parse(text));
	} catch {
		return emptyCache();
	}
}

/** 用匹配当前 endpoint 的缓存补全配置；无手写模型且无缓存的 provider 暂不注册。 */
export function resolveCachedModelsJsoncConfig(config: ModelsJsoncConfig, cache: ModelsDiscoveryCache): ModelsJsoncConfig {
	const entries: Array<[string, ProviderConfig]> = [];
	for (const [providerId, provider] of Object.entries(config.providers)) {
		const cached = cache.providers[providerId];
		const discoveredModels = cached?.source === cacheSource(provider) ? cached.models : [];
		const models = Array.isArray(provider.models)
			? mergeConfiguredAndDiscoveredModels(provider.models, discoveredModels)
			: discoveredModels;
		if (models.length === 0) continue;
		entries.push([providerId, { ...provider, models }]);
	}
	return { providers: Object.fromEntries(entries) };
}

/** 并发刷新所有 provider；单个失败保留旧缓存，成功结果原子写盘。 */
export async function refreshModelsDiscoveryCache(
	config: ModelsJsoncConfig,
	configPath: string,
	currentCache: ModelsDiscoveryCache,
	options: RefreshModelsCacheOptions = {},
): Promise<ModelsRefreshResult> {
	const results = await Promise.all(Object.entries(config.providers).map(async ([providerId, provider]) => {
		try {
			const models = await fetchProviderModelsFromEndpoint(providerId, provider, configPath, options);
			return { providerId, provider, models } as const;
		} catch (error) {
			return { providerId, provider, error } as const;
		}
	}));

	const providerEntries: Array<[string, CachedProviderModels]> = [];
	const updatedProviderIds: string[] = [];
	const failures: ModelsRefreshFailure[] = [];
	for (const result of results) {
		const source = cacheSource(result.provider);
		if ("models" in result) {
			providerEntries.push([result.providerId, { source, models: result.models }]);
			updatedProviderIds.push(result.providerId);
			continue;
		}
		failures.push({ providerId: result.providerId, error: result.error });
		const cached = currentCache.providers[result.providerId];
		if (cached?.source === source) providerEntries.push([result.providerId, cached]);
	}

	const cache: ModelsDiscoveryCache = { version: CACHE_VERSION, providers: Object.fromEntries(providerEntries) };
	const changed = !sameCache(currentCache, cache);
	if (changed && !options.signal?.aborted) {
		await writeModelsDiscoveryCache(cache, options.cachePath ?? defaultModelsCachePath());
	}
	return { cache, changed, updatedProviderIds, failures };
}

async function writeModelsDiscoveryCache(cache: ModelsDiscoveryCache, cachePath: string): Promise<void> {
	const directory = path.dirname(cachePath);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const tempPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(tempPath, `${JSON.stringify(cache, undefined, 2)}\n`, { mode: 0o600 });
		await rename(tempPath, cachePath);
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
}

function parseCache(value: unknown): ModelsDiscoveryCache {
	if (!isRecord(value) || value.version !== CACHE_VERSION || !isRecord(value.providers)) return emptyCache();
	const providerEntries: Array<[string, CachedProviderModels]> = [];
	for (const [providerId, entry] of Object.entries(value.providers)) {
		if (!isRecord(entry) || typeof entry.source !== "string" || !Array.isArray(entry.models)) continue;
		const models = entry.models.map(parseCachedModel);
		if (models.some((model) => model === undefined)) continue;
		providerEntries.push([
			providerId,
			{ source: entry.source, models: models.filter((model): model is ModelConfig => model !== undefined) },
		]);
	}
	return { version: CACHE_VERSION, providers: Object.fromEntries(providerEntries) };
}

function parseCachedModel(value: unknown): ModelConfig | undefined {
	if (!isRecord(value) || typeof value.model !== "string" || value.model.length === 0) return undefined;
	const allowed = new Set(["model", "display_name", "context_window", "max_tokens", "input"]);
	if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
	if (value.display_name !== undefined && (typeof value.display_name !== "string" || value.display_name.length === 0)) return undefined;
	if (value.context_window !== undefined && !isPositiveNumber(value.context_window)) return undefined;
	if (value.max_tokens !== undefined && !isPositiveNumber(value.max_tokens)) return undefined;
	if (value.input !== undefined && !isModelInput(value.input)) return undefined;
	return {
		model: value.model,
		...(typeof value.display_name === "string" ? { display_name: value.display_name } : {}),
		...(typeof value.context_window === "number" ? { context_window: value.context_window } : {}),
		...(typeof value.max_tokens === "number" ? { max_tokens: value.max_tokens } : {}),
		...(isModelInput(value.input) ? { input: value.input } : {}),
	};
}

function mergeConfiguredAndDiscoveredModels(
	configuredModels: Array<string | ModelConfig>,
	discoveredModels: ModelConfig[],
): Array<string | ModelConfig> {
	const configuredIds = new Set(configuredModels.map((model) => typeof model === "string" ? model : model.model));
	return [...configuredModels, ...discoveredModels.filter((model) => !configuredIds.has(model.model))];
}

function sameCache(left: ModelsDiscoveryCache, right: ModelsDiscoveryCache): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function cacheSource(provider: ProviderConfig): string {
	return `sha256:${createHash("sha256").update(modelsEndpointUrl(provider)).digest("hex")}`;
}

function emptyCache(): ModelsDiscoveryCache {
	return { version: CACHE_VERSION, providers: {} };
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isModelInput(value: unknown): value is Array<"text" | "image"> {
	return Array.isArray(value) && value.every((item) => item === "text" || item === "image");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
