import { readFile } from "node:fs/promises";
import path from "node:path";
import { Agent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultWebToolsConfig } from "../src/web-tools/config.js";
import { SearchRequestGate } from "../src/web-tools/search-request-gate.js";
import { SearchCache } from "../src/web-tools/search-cache.js";
import type { WebHttpFetch, WebHttpRequestInit, WebHttpResponse } from "../src/web-tools/types.js";
import { executeWebSearch } from "../src/web-tools/websearch-tool.js";

afterEach(() => {
	vi.useRealTimers();
});

class FakeBody {
	constructor(private readonly chunks: Uint8Array[]) {}
	getReader() {
		let index = 0;
		return {
			read: async () => {
				const value = this.chunks[index];
				index += 1;
				return value === undefined ? { done: true as const } : { done: false as const, value };
			},
			cancel: async () => undefined,
		};
	}
	async cancel(): Promise<void> {}
}

const fixtureDir = path.join(process.cwd(), "tests", "fixtures", "websearch");

async function fixture(name: string): Promise<string> {
	return readFile(path.join(fixtureDir, name), "utf8");
}

function response(status: number, body: string, headers: Record<string, string> = { "content-type": "text/html" }): WebHttpResponse {
	return {
		status,
		statusText: status === 200 ? "OK" : "Error",
		headers: new Headers(headers),
		body: new FakeBody([Buffer.from(body)]),
	};
}

function runtime(fetchImpl: WebHttpFetch, now = () => Date.now()) {
	const config = defaultWebToolsConfig();
	config.websearch.default_results = 2;
	config.websearch.region = "wt-wt";
	return {
		dispatcher: new Agent(),
		fetchImpl,
		config,
		searches: new SearchCache(now),
		requestGate: new SearchRequestGate(now, 0, 0),
		context: { toolCallId: "s1" },
		now,
	};
}

describe("websearch tool", () => {
	it("校验 query、limit 和 recency", async () => {
		const rt = runtime(async () => response(200, ""));
		await expect(executeWebSearch({ query: "" }, rt)).resolves.toMatchObject({ details: { status: "failed", error: { code: "INVALID_ARGUMENT" } } });
		await expect(executeWebSearch({ query: "x".repeat(513) }, rt)).resolves.toMatchObject({ details: { status: "failed", error: { code: "INVALID_ARGUMENT" } } });
		await expect(executeWebSearch({ query: "x", limit: 21 }, rt)).resolves.toMatchObject({ details: { status: "failed", error: { code: "INVALID_ARGUMENT" } } });
		await expect(executeWebSearch({ query: "x", recency: "hour" as never }, rt)).resolves.toMatchObject({ details: { status: "failed", error: { code: "INVALID_ARGUMENT" } } });
	});

	it("使用 GET、region、recency、请求头和默认 limit", async () => {
		let seen: { input: URL; init: WebHttpRequestInit } | undefined;
		const rt = runtime(async (input, init) => {
			seen = { input, init };
			return response(200, await fixture("results.html"));
		});
		const result = await executeWebSearch({ query: 'pi "coding agent"', recency: "week" }, rt);
		expect(result.details).toMatchObject({ status: "success" });
		if (seen === undefined) throw new Error("missing request");
		expect(seen.input.origin + seen.input.pathname).toBe("https://html.duckduckgo.com/html/");
		expect(seen?.init.method).toBe("GET");
		expect(seen?.init.redirect).toBe("manual");
		expect(seen?.init.headers["User-Agent"]).toContain("Mozilla/5.0");
		expect(seen?.init.headers["Content-Type"]).toBeUndefined();
		expect(seen?.input.searchParams.get("q")).toBe('pi "coding agent"');
		expect(seen?.input.searchParams.get("kl")).toBe("wt-wt");
		expect(seen?.input.searchParams.get("df")).toBe("w");
		if (result.details.status !== "success") throw new Error("search failed");
		expect(result.details.results).toHaveLength(2);
	});

	it("映射 provider block、HTTP error、非 HTML 和响应超限", async () => {
		await expect(executeWebSearch({ query: "x" }, runtime(async () => response(429, "blocked")))).resolves.toMatchObject({ details: { status: "failed", error: { code: "PROVIDER_BLOCKED" } } });
		await expect(executeWebSearch({ query: "x" }, runtime(async () => response(202, await fixture("challenge.html"))))).resolves.toMatchObject({ details: { status: "failed", error: { code: "PROVIDER_BLOCKED" } } });
		await expect(executeWebSearch({ query: "x" }, runtime(async () => response(500, "server failed")))).resolves.toMatchObject({ details: { status: "failed", error: { code: "HTTP_ERROR" }, response_preview: "server failed" } });
		await expect(executeWebSearch({ query: "x" }, runtime(async () => response(200, "{}", { "content-type": "application/json" })))).resolves.toMatchObject({ details: { status: "failed", error: { code: "UNSUPPORTED_CONTENT_TYPE" } } });
		await expect(executeWebSearch({ query: "x" }, runtime(async () => response(200, "x", { "content-type": "text/html", "content-length": "2097153" })))).resolves.toMatchObject({ details: { status: "failed", error: { code: "RESPONSE_TOO_LARGE" } } });
	});

	it("区分 timeout 和用户取消", async () => {
		const userAbort = new AbortController();
		userAbort.abort();
		await expect(
			executeWebSearch({ query: "x" }, { ...runtime(async (_input, init) => {
				if (init.signal.aborted) throw new Error("aborted");
				return response(200, "");
			}), context: { toolCallId: "s1", signal: userAbort.signal } }),
		).resolves.toMatchObject({ details: { status: "failed", error: { code: "ABORTED" } } });

		const rt = runtime(async (_input, init) => new Promise<WebHttpResponse>((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")), { once: true });
		}));
		rt.config.websearch.timeout_seconds = 1;
		await expect(executeWebSearch({ query: "x" }, rt)).resolves.toMatchObject({ details: { status: "failed", error: { code: "TIMEOUT" } } });
	});

	it("模型输出 XML 转义，failure content 不含 response_preview", async () => {
		const result = await executeWebSearch({ query: "<pi>&" }, runtime(async () => response(200, await fixture("results.html"))));
		expect(result.content).toContain('query="&lt;pi&gt;&amp;"');
		expect(result.content).toContain("<websearch_results");
		const failed = await executeWebSearch({ query: "x" }, runtime(async () => response(500, "<html>secret preview</html>")));
		expect(failed.details).toMatchObject({ status: "failed", response_preview: "secret preview" });
		expect(failed.content).not.toContain("secret preview");
	});

	it("缓存命中不发第二次请求，并按 limit 和 recency 隔离", async () => {
		let calls = 0;
		const rt = runtime(async () => {
			calls += 1;
			return response(200, await fixture("results.html"));
		});
		await executeWebSearch({ query: "pi", limit: 1 }, rt);
		const cached = await executeWebSearch({ query: "pi", limit: 1 }, rt);
		expect(calls).toBe(1);
		expect(cached.details).toMatchObject({ status: "success", cached: true });
		await executeWebSearch({ query: "pi", limit: 2 }, rt);
		await executeWebSearch({ query: "pi", limit: 1, recency: "day" }, rt);
		expect(calls).toBe(3);
	});

	it("连续请求会经由请求闸门等待", async () => {
		vi.useFakeTimers();
		let now = 0;
		const rt = runtime(async () => response(200, await fixture("results.html")), () => now);
		rt.requestGate = new SearchRequestGate(() => now, 15000, 600000);
		await executeWebSearch({ query: "first" }, rt);
		const second = executeWebSearch({ query: "second" }, rt);
		now += 14999;
		await vi.advanceTimersByTimeAsync(14999);
		let settled = false;
		second.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		now += 1;
		await vi.advanceTimersByTimeAsync(1);
		await second;
	});

	it("provider blocked 后进入冷却期，不再继续请求 DDG", async () => {
		let calls = 0;
		let now = 0;
		const rt = runtime(async () => {
			calls += 1;
			return response(202, await fixture("challenge.html"));
		}, () => now);
		rt.requestGate = new SearchRequestGate(() => now, 0, 600000);
		const first = await executeWebSearch({ query: "first" }, rt);
		expect(first.details).toMatchObject({ status: "failed", error: { code: "PROVIDER_BLOCKED" } });
		now += 1000;
		const second = await executeWebSearch({ query: "second" }, rt);
		expect(second.details).toMatchObject({ status: "failed", error: { code: "PROVIDER_BLOCKED" } });
		expect(calls).toBe(1);
		expect(second.content).toContain("Retry after");
	});
});
