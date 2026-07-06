import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultWebToolsConfig } from "../../src/web-tools/config.js";
import { apiKeyHeaders, createExaMcpProvider, normalizeExaMcpResult, type ExaMcpClient, type ExaMcpClientFactory } from "../../src/web-tools/search-providers/exa-mcp.js";

const previousKey = process.env.EXA_API_KEY;

afterEach(() => {
	vi.useRealTimers();
	if (previousKey === undefined) delete process.env.EXA_API_KEY;
	else process.env.EXA_API_KEY = previousKey;
});

describe("exa MCP provider", () => {
	it("映射 structured results 并清理 URL", () => {
		const results = normalizeExaMcpResult(
			{
				structuredContent: {
					results: [
						{ title: "A", url: "https://example.com/a?utm_source=x&ok=1#hash", snippet: " Text " },
						{ name: "B", link: "https://user:pass@example.com/private", text: "skip" },
						{ name: "C", link: "ftp://example.com/c" },
					],
				},
			},
			10,
		);
		expect(results).toEqual([{ rank: 1, title: "A", url: "https://example.com/a?ok=1", snippet: "Text" }]);
	});

	it("从 text JSON、Markdown link 和裸 URL 抽取结果", () => {
		expect(normalizeExaMcpResult({ content: [{ type: "text", text: '{"results":[{"title":"A","url":"https://a.test/"}]}' }] }, 5)).toMatchObject([
			{ rank: 1, title: "A", url: "https://a.test/" },
		]);
		expect(normalizeExaMcpResult({ content: [{ type: "text", text: "[B](https://b.test/path) and https://c.test/x" }] }, 5)).toMatchObject([
			{ rank: 1, title: "B", url: "https://b.test/path" },
			{ rank: 2, title: "https://c.test/x", url: "https://c.test/x" },
		]);
	});

	it("无 URL 时返回 PARSE_FAILED", async () => {
		const provider = createExaMcpProvider(defaultWebToolsConfig().websearch.exa_mcp, factory({ content: [{ type: "text", text: "no links" }] }));
		const result = await provider.search({ query: "pi", limit: 2 }, { now: () => 0 });
		expect(result).toMatchObject({ status: "failed", provider: "exa_mcp", details: { error: { code: "PARSE_FAILED" } } });
	});

	it("API key 只通过 x-api-key header 注入", () => {
		process.env.EXA_API_KEY = "secret-key";
		expect(apiKeyHeaders(defaultWebToolsConfig().websearch.exa_mcp)).toEqual({ "x-api-key": "secret-key" });
		delete process.env.EXA_API_KEY;
		expect(apiKeyHeaders(defaultWebToolsConfig().websearch.exa_mcp)).toBeUndefined();
	});

	it("用户取消和超时分别映射为 ABORTED/TIMEOUT", async () => {
		const aborted = new AbortController();
		aborted.abort();
		const abortProvider = createExaMcpProvider(defaultWebToolsConfig().websearch.exa_mcp, throwingFactory(new DOMException("aborted", "AbortError")));
		await expect(abortProvider.search({ query: "pi", limit: 1 }, { now: () => 0, signal: aborted.signal })).resolves.toMatchObject({
			status: "failed",
			details: { error: { code: "ABORTED" } },
		});

		vi.useFakeTimers();
		const config = defaultWebToolsConfig().websearch.exa_mcp;
		config.timeout_seconds = 1;
		const timeoutProvider = createExaMcpProvider(config, pendingFactory());
		const pending = timeoutProvider.search({ query: "pi", limit: 1 }, { now: () => 0 });
		await vi.advanceTimersByTimeAsync(1000);
		await expect(pending).resolves.toMatchObject({ status: "failed", details: { error: { code: "TIMEOUT" } } });
	});

	it("MCP 错误消息不泄漏 API key 或 URL query", async () => {
		process.env.EXA_API_KEY = "secret-key";
		const config = defaultWebToolsConfig().websearch.exa_mcp;
		const provider = createExaMcpProvider(config, throwingFactory(new Error("failed secret-key https://mcp.exa.ai/mcp?key=secret-key")));
		const result = await provider.search({ query: "pi", limit: 1 }, { now: () => 0 });
		expect(result).toMatchObject({ status: "failed", details: { error: { code: "MCP_ERROR" } } });
		expect(result.status === "failed" ? result.details.error.message : "").not.toContain("secret-key");
		expect(result.status === "failed" ? result.details.error.message : "").toContain("https://mcp.exa.ai/mcp");
		expect(result.status === "failed" ? result.details.error.message : "").not.toContain("?key=");
	});
});

function factory(raw: unknown): ExaMcpClientFactory {
	return {
		async connect() {
			return {
				async callTool() {
					return raw;
				},
				async close() {},
			};
		},
	};
}

function throwingFactory(error: Error): ExaMcpClientFactory {
	return {
		async connect() {
			throw error;
		},
	};
}

function pendingFactory(): ExaMcpClientFactory {
	return {
		async connect(): Promise<ExaMcpClient> {
			return {
				callTool(_args, options) {
					return new Promise((_resolve, reject) => {
						options?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")), { once: true });
					});
				},
				async close() {},
			};
		},
	};
}
