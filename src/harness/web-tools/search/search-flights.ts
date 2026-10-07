import { createHash } from "node:crypto";

import type { SearchRouterResult } from "../search-providers/router.ts";
import type { NormalizedSearchParams, ResolvedSearchProvider } from "../search-providers/types.ts";
import type { WebToolsConfig } from "../config-types.ts";
import type { WebSearchExecutionContext } from "../core/types.ts";
import { networkConfigSignature } from "../network/dispatcher.ts";

type SearchCaller = Pick<WebSearchExecutionContext, "signal" | "onUpdate">;
type SharedSearch = (context: {
	signal: AbortSignal;
	onUpdate: NonNullable<WebSearchExecutionContext["onUpdate"]>;
}) => Promise<SearchRouterResult>;

interface SearchListener {
	onUpdate: WebSearchExecutionContext["onUpdate"];
}

interface SearchFlight {
	controller: AbortController;
	listeners: Set<SearchListener>;
	result: Promise<SearchRouterResult>;
}

/** 会话内合并在途搜索。调用者独立取消，全部退出才中止共享任务。 */
export class SearchFlights {
	private readonly inFlight = new Map<string, SearchFlight>();
	private readonly active = new Set<Promise<void>>();

	async close(): Promise<void> {
		// 全部调用者取消后，传输层可能仍在清理连接。
		await Promise.all(this.active);
	}

	run(key: string, caller: SearchCaller, execute: SharedSearch): Promise<SearchRouterResult> {
		if (caller.signal?.aborted) return Promise.resolve(aborted());
		const flight = this.inFlight.get(key) ?? this.start(key, execute);
		return new Promise((resolve, reject) => {
			const listener = { onUpdate: caller.onUpdate };
			const detach = () => {
				flight.listeners.delete(listener);
				caller.signal?.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				detach();
				if (flight.listeners.size === 0) {
					if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
					flight.controller.abort();
				}
				resolve(aborted());
			};
			flight.listeners.add(listener);
			caller.signal?.addEventListener("abort", onAbort, { once: true });
			void flight.result.then(
				(result) => { detach(); resolve(result); },
				(error: unknown) => { detach(); reject(error); },
			);
		});
	}

	private start(key: string, execute: SharedSearch): SearchFlight {
		const controller = new AbortController();
		const listeners = new Set<SearchListener>();
		// 先登记调用者，再启动请求，避免遗漏同步进度或提前取消。
		const result = Promise.resolve().then(() => execute({
			signal: controller.signal,
			onUpdate(update) {
				for (const listener of listeners) listener.onUpdate?.(update);
			},
		}));
		const flight = { controller, listeners, result };
		this.inFlight.set(key, flight);
		const remove = () => {
			// 旧任务清理不能删除取消后新建的同名任务。
			if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
			this.active.delete(finished);
		};
		const finished = result.then(remove, remove);
		this.active.add(finished);
		return flight;
	}
}

function aborted(): SearchRouterResult {
	return { status: "failed", error: { code: "ABORTED", message: "websearch request was aborted." }, attempts: [] };
}

/** 指纹只使用本次请求的参数、配置和已解析凭据，不触发配置解析。 */
export function searchFlightKey(params: NormalizedSearchParams, config: WebToolsConfig, providers: readonly ResolvedSearchProvider[]): string {
	return JSON.stringify({
		params,
		deadlineSeconds: config.websearch.total_deadline_seconds,
		primary: config.websearch.primary_providers,
		providers: providers.map((provider) => provider.id === "exa_mcp" ? provider : {
			...provider, key: provider.key === undefined ? undefined : createHash("sha256").update(provider.key).digest("hex"),
		}),
		network: networkConfigSignature(config.network),
	});
}
