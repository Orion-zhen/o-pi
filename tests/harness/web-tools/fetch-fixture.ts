import { Agent } from "undici";
import { afterEach } from "vitest";
import { SnapshotCache } from "../../../src/harness/web-tools/fetch/snapshot-cache.ts";
import type { ExecuteWebFetchRuntime } from "../../../src/harness/web-tools/fetch/webfetch-tool.ts";
import type { WebHttpFetch } from "../../../src/harness/web-tools/network/types.ts";
import { defaultWebToolsConfig } from "./config-fixture.ts";

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
			dispatcher, fetchImpl, config: defaultWebToolsConfig(),
			cookieStore: { async getCookieAccess() { return {}; }, async storeFromResponse() {} },
			snapshots: new SnapshotCache(), approvedAuthOrigins: new Set<string>(),
			context: { toolCallId: "fetch", acceptsImages: true }, now: () => Date.now(),
		};
		configure?.(runtime);
		return { ...runtime, ...overrides, context: { ...runtime.context, ...overrides.context } };
	};
}
