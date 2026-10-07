import { Agent } from "undici";
import { afterEach, beforeEach, vi } from "vitest";

import { createWebSearchRuntime } from "../../../src/harness/web-tools/search/websearch-runtime.ts";
import type { WebSearchCapability } from "../../../src/harness/web-tools/core/runtime-types.ts";
import type { WebHttpFetch } from "../../../src/harness/web-tools/network/types.ts";
import { defaultWebToolsConfig } from "./config-fixture.ts";

export function useWebSearch() {
	let config: ReturnType<typeof defaultWebToolsConfig>;
	let dispatcher: Agent;
	let runtime: WebSearchCapability;
	const fetchImpl = vi.fn<WebHttpFetch>();
	beforeEach(() => {
		config = defaultWebToolsConfig();
		for (const id of [...config.websearch.primary_providers, ...config.websearch.auxiliary_providers]) config.websearch[id].enabled = false;
		config.websearch.brave_api.enabled = true;
		config.websearch.brave_api.api_key = "test-key";
		dispatcher = new Agent();
		fetchImpl.mockReset().mockRejectedValue(new Error("unexpected HTTP request"));
		runtime = createWebSearchRuntime({
			loadConfig: async () => structuredClone(config), getDispatcher: async () => dispatcher,
			fetchImpl, now: () => Date.now(),
		});
	});
	afterEach(async () => { await runtime.close(); await dispatcher.close(); });
	return { get config() { return config; }, get runtime() { return runtime; }, fetchImpl };
}
