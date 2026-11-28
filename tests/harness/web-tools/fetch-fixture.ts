import { Agent } from "undici";
import { afterEach } from "vitest";
import { SnapshotCache } from "../../../src/harness/web-tools/fetch/snapshot-cache.ts";
import type { ExecuteWebFetchRuntime } from "../../../src/harness/web-tools/fetch/webfetch-tool.ts";
import type { WebHttpFetch } from "../../../src/harness/web-tools/network/types.ts";

type RuntimeOverrides = Partial<Omit<ExecuteWebFetchRuntime, "context">> & {
	context?: Partial<ExecuteWebFetchRuntime["context"]>;
};

export function useWebFetchRuntime(configure?: (runtime: ExecuteWebFetchRuntime) => void) {
	const dispatchers: Agent[] = [];
	afterEach(async () => { await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close())); });
	return (fetchImpl: WebHttpFetch, overrides: RuntimeOverrides = {}): ExecuteWebFetchRuntime => {
		const dispatcher = new Agent();
		dispatchers.push(dispatcher);
		const runtime: ExecuteWebFetchRuntime = {
			dispatcher, fetchImpl,
			config: { webfetch: {
				timeout_seconds: 30, max_redirects: 3, user_agent: "WebFetchTest",
				readability: { char_threshold: 500 }, media: { mode: "auto", response_bytes: 5 * 1024 * 1024 },
				limits: { response_bytes: 10 * 1024 * 1024, default_output_chars: 20000, find_max_passages: 8 },
				cookies: { enabled: true, blacklist: [] },
			} },
			cookieStore: { async getCookieAccess() { return {}; }, async storeFromResponse() {} },
			snapshots: new SnapshotCache(),
			context: { toolCallId: "fetch", acceptsImages: true }, now: () => Date.now(),
		};
		configure?.(runtime);
		return { ...runtime, ...overrides, context: { ...runtime.context, ...overrides.context } };
	};
}
