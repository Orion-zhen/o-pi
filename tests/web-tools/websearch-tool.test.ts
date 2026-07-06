import { describe, expect, it } from "vitest";

import { defaultWebToolsConfig } from "../../src/web-tools/config.js";
import { SearchProviderRouter } from "../../src/web-tools/search-providers/router.js";
import type { SearchProviderContext, SearchProviderResult, WebSearchProvider } from "../../src/web-tools/search-providers/types.js";
import { SearchCache } from "../../src/web-tools/search-cache.js";
import type { WebSearchProviderId } from "../../src/web-tools/types.js";
import { executeWebSearch } from "../../src/web-tools/websearch-tool.js";

function runtime(providers: WebSearchProvider[], now = () => Date.now()) {
	const config = defaultWebToolsConfig();
	config.websearch.default_results = 2;
	return {
		config,
		searches: new SearchCache(now),
		router: new SearchProviderRouter(providers, config.websearch),
		context: { toolCallId: "s1" },
		now,
	};
}

function successProvider(id: WebSearchProviderId, calls: { count: number }): WebSearchProvider {
	return {
		id,
		async search(): Promise<SearchProviderResult> {
			calls.count += 1;
			return {
				status: "success",
				provider: id,
				downloadedBytes: 123,
				results: [
					{ rank: 1, title: "<Title>&", url: "https://example.com/?a=1", snippet: "Snippet" },
					{ rank: 2, title: "Second", url: "https://example.org/" },
				],
			};
		},
	};
}

function failedProvider(id: WebSearchProviderId): WebSearchProvider {
	return {
		id,
		async search(_params, context: SearchProviderContext): Promise<SearchProviderResult> {
			context.onUpdate?.({ content: "Searching...", details: { status: "progress", phase: "requesting" } });
			return {
				status: "failed",
				provider: id,
				details: {
					status: "failed",
					error: { code: "MCP_ERROR", message: "failed without secret" },
					provider: id,
					response_preview: "secret preview",
				},
			};
		},
	};
}

describe("websearch tool", () => {
	it("校验 query 和 limit", async () => {
		const rt = runtime([]);
		await expect(executeWebSearch({ query: "" }, rt)).resolves.toMatchObject({ details: { status: "failed", error: { code: "INVALID_ARGUMENT" } } });
		await expect(executeWebSearch({ query: "x".repeat(513) }, rt)).resolves.toMatchObject({ details: { status: "failed", error: { code: "INVALID_ARGUMENT" } } });
		await expect(executeWebSearch({ query: "x", limit: 21 }, rt)).resolves.toMatchObject({ details: { status: "failed", error: { code: "INVALID_ARGUMENT" } } });
	});

	it("成功模型输出包含 provider、Source 且 XML 转义", async () => {
		const calls = { count: 0 };
		const result = await executeWebSearch({ query: "<pi>&" }, runtime([successProvider("exa_mcp", calls)]));
		expect(result.details).toMatchObject({ status: "success", provider: "exa_mcp", cached: false });
		expect(result.content).toContain('query="&lt;pi&gt;&amp;"');
		expect(result.content).toContain('provider="exa_mcp"');
		expect(result.content).toContain("[1] &lt;Title&gt;&amp;");
		expect(result.content).toContain("Source: exa_mcp");
		expect(calls.count).toBe(1);
	});

	it("缓存命中不调用 provider，并保留原成功 provider", async () => {
		const calls = { count: 0 };
		const rt = runtime([successProvider("duckduckgo_html", calls)]);
		await executeWebSearch({ query: "pi", limit: 1 }, rt);
		const cached = await executeWebSearch({ query: "pi", limit: 1 }, rt);
		expect(calls.count).toBe(1);
		expect(cached.details).toMatchObject({
			status: "success",
			provider: "duckduckgo_html",
			cached: true,
			attempts: [{ provider: "duckduckgo_html", status: "success", cached: true }],
		});
		await executeWebSearch({ query: "pi", limit: 2 }, rt);
		expect(calls.count).toBe(2);
	});

	it("失败模型输出不包含 response_preview 或 attempts 长诊断", async () => {
		const result = await executeWebSearch({ query: "x" }, runtime([failedProvider("exa_mcp")]));
		expect(result.details).toMatchObject({ status: "failed", response_preview: "secret preview" });
		expect(result.details.status === "failed" ? result.details.attempts?.[0] : undefined).toMatchObject({ provider: "exa_mcp", status: "failed" });
		expect(result.content).toContain('"provider": "exa_mcp"');
		expect(result.content).not.toContain("secret preview");
		expect(result.content).not.toContain("attempts");
	});
});
