import { createHash } from "node:crypto";

import { resolveSearchApiKey } from "../search-providers/api-key.js";
import type { WebToolsConfig } from "../core/types.js";

/** 会话内只合并相同 key 的并发搜索，不缓存已完成结果。 */
export class SearchCache {
	private readonly inFlight = new Map<string, Promise<unknown>>();

	clear(): void {
		this.inFlight.clear();
	}

	runSingleflight<T>(key: string, execute: () => Promise<T>): Promise<T> {
		const existing = this.inFlight.get(key);
		if (existing !== undefined) return existing as Promise<T>;
		const pending = execute();
		this.inFlight.set(key, pending);
		void pending.finally(() => {
			if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
		}).catch(() => undefined);
		return pending;
	}
}

export function searchCacheKey(query: string, limit: number, config: WebToolsConfig["websearch"], signature = providerSignature(config)): string {
	return [query.trim(), String(limit), signature].join("\0");
}

/** provider 配置签名保留用于配置/API key 变化时重建 router 和 singleflight key。 */
export function providerSignature(config: WebToolsConfig["websearch"]): string {
	return JSON.stringify({
		...config,
		brave_api: providerConfigSignature(config.brave_api),
		exa_api: providerConfigSignature(config.exa_api),
		tavily: providerConfigSignature(config.tavily),
	});
}

function providerConfigSignature<T extends { api_key: string }>(config: T): Omit<T, "api_key"> & { api_key: string } {
	const material = resolveSearchApiKey(config.api_key) ?? config.api_key;
	return { ...config, api_key: createHash("sha256").update(material).digest("hex") };
}
