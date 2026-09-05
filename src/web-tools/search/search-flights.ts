import { createHash } from "node:crypto";

import { resolveSearchApiKey } from "../search-providers/api-key.js";
import type { SearchRouterResult } from "../search-providers/router.js";
import type { WebToolsConfig } from "../core/types.js";

/** 会话内只合并相同 key 的并发搜索，不缓存已完成结果。 */
export class SearchFlights {
	private readonly inFlight = new Map<string, Promise<SearchRouterResult>>();

	clear(): void {
		this.inFlight.clear();
	}

	run(key: string, execute: () => Promise<SearchRouterResult>): Promise<SearchRouterResult> {
		const existing = this.inFlight.get(key);
		if (existing !== undefined) return existing;
		const pending = execute();
		this.inFlight.set(key, pending);
		const remove = () => {
			this.inFlight.delete(key);
		};
		void pending.then(remove, remove);
		return pending;
	}
}

export function searchFlightKey(query: string, limit: number, config: WebToolsConfig["websearch"], signature = providerSignature(config)): string {
	return [query.trim(), String(limit), signature].join("\0");
}

/** 配置或 API key 变化时重建 router，并隔离正在执行的搜索。 */
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
