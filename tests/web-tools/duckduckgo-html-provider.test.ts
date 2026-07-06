import { readFile } from "node:fs/promises";
import path from "node:path";
import { Agent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultWebToolsConfig } from "../../src/web-tools/config.js";
import { createDuckDuckGoHtmlProvider } from "../../src/web-tools/search-providers/duckduckgo-html-provider.js";
import { SearchRequestGate } from "../../src/web-tools/search-request-gate.js";
import type { WebHttpFetch, WebHttpRequestInit, WebHttpResponse } from "../../src/web-tools/types.js";

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

const fixtureDir = path.join(process.cwd(), "tests", "web-tools", "fixtures", "websearch");

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

function provider(fetchImpl: WebHttpFetch, now = () => Date.now(), gate = new SearchRequestGate(now, 0, 0), timeoutSeconds?: number) {
	const config = defaultWebToolsConfig().websearch.duckduckgo_html;
	if (timeoutSeconds !== undefined) config.timeout_seconds = timeoutSeconds;
	return createDuckDuckGoHtmlProvider({
		config,
		dispatcher: new Agent(),
		fetchImpl,
		requestGate: gate,
	});
}

describe("duckduckgo HTML provider", () => {
	it("使用 GET、region、请求头和 limit", async () => {
		let seen: { input: URL; init: WebHttpRequestInit } | undefined;
		const ddg = provider(async (input, init) => {
			seen = { input, init };
			return response(200, await fixture("results.html"));
		});
		const result = await ddg.search({ query: 'pi "coding agent"', limit: 2 }, { now: () => 0 });
		expect(result).toMatchObject({ status: "success", provider: "duckduckgo_html" });
		if (seen === undefined) throw new Error("missing request");
		expect(seen.input.origin + seen.input.pathname).toBe("https://html.duckduckgo.com/html/");
		expect(seen.init.method).toBe("GET");
		expect(seen.init.redirect).toBe("manual");
		expect(seen.init.headers["User-Agent"]).toContain("Mozilla/5.0");
		expect(seen.input.searchParams.get("q")).toBe('pi "coding agent"');
		expect(seen.input.searchParams.get("kl")).toBe("wt-wt");
		expect(seen.input.searchParams.has("df")).toBe(false);
	});

	it("映射 provider block、HTTP error、非 HTML 和响应超限", async () => {
		await expect(provider(async () => response(429, "blocked")).search({ query: "x", limit: 1 }, { now: () => 0 })).resolves.toMatchObject({ status: "failed", details: { error: { code: "PROVIDER_BLOCKED" } } });
		await expect(provider(async () => response(202, await fixture("challenge.html"))).search({ query: "x", limit: 1 }, { now: () => 0 })).resolves.toMatchObject({ status: "failed", details: { error: { code: "PROVIDER_BLOCKED" } } });
		await expect(provider(async () => response(500, "server failed")).search({ query: "x", limit: 1 }, { now: () => 0 })).resolves.toMatchObject({ status: "failed", details: { error: { code: "HTTP_ERROR" }, response_preview: "server failed" } });
		await expect(provider(async () => response(200, "{}", { "content-type": "application/json" })).search({ query: "x", limit: 1 }, { now: () => 0 })).resolves.toMatchObject({ status: "failed", details: { error: { code: "UNSUPPORTED_CONTENT_TYPE" } } });
		await expect(provider(async () => response(200, "x", { "content-type": "text/html", "content-length": "2097153" })).search({ query: "x", limit: 1 }, { now: () => 0 })).resolves.toMatchObject({ status: "failed", details: { error: { code: "RESPONSE_TOO_LARGE" } } });
	});

	it("区分 timeout 和用户取消", async () => {
		const userAbort = new AbortController();
		userAbort.abort();
		await expect(
			provider(async (_input, init) => {
				if (init.signal.aborted) throw new Error("aborted");
				return response(200, "");
			}).search({ query: "x", limit: 1 }, { now: () => 0, signal: userAbort.signal }),
		).resolves.toMatchObject({ status: "failed", details: { error: { code: "ABORTED" } } });

		const ddg = provider(async (_input, init) => new Promise<WebHttpResponse>((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")), { once: true });
		}), () => Date.now(), new SearchRequestGate(() => Date.now(), 0, 0), 1);
		await expect(ddg.search({ query: "x", limit: 1 }, { now: () => 0 })).resolves.toMatchObject({ status: "failed", details: { error: { code: "TIMEOUT" } } });
	});

	it("连续请求经由请求闸门等待，blocked 后进入 DDG 冷却期", async () => {
		vi.useFakeTimers();
		let now = 0;
		const gate = new SearchRequestGate(() => now, 15000, 600000);
		const ddg = provider(async () => response(200, await fixture("results.html")), () => now, gate);
		await ddg.search({ query: "first", limit: 1 }, { now: () => now });
		const second = ddg.search({ query: "second", limit: 1 }, { now: () => now });
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

		let calls = 0;
		now = 0;
		const blockGate = new SearchRequestGate(() => now, 0, 600000);
		const blocked = provider(async () => {
			calls += 1;
			return response(202, await fixture("challenge.html"));
		}, () => now, blockGate);
		await expect(blocked.search({ query: "first", limit: 1 }, { now: () => now })).resolves.toMatchObject({ status: "failed", details: { error: { code: "PROVIDER_BLOCKED" } } });
		now += 1000;
		await expect(blocked.search({ query: "second", limit: 1 }, { now: () => now })).resolves.toMatchObject({ status: "failed", details: { error: { code: "PROVIDER_BLOCKED" } } });
		expect(calls).toBe(1);
	});
});
