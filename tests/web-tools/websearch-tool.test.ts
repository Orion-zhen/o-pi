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
		async search(params): Promise<SearchProviderResult> {
			calls.count += 1;
			return {
				status: "success",
				provider: id,
				downloadedBytes: 123,
				results: [
					{ rank: 1, title: "<Title>&", url: "https://example.com/?a=1", snippet: `Snippet for ${params.query}` },
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
					error: { code: "HTTP_ERROR", message: "failed without secret" },
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
		await expect(executeWebSearch({ query: "x", freshness: { start: "2025-02-31" } }, rt)).resolves.toMatchObject({ details: { status: "failed", error: { code: "INVALID_ARGUMENT" } } });
		await expect(executeWebSearch({ query: "site:example.com -site:example.com x" }, rt)).resolves.toMatchObject({ details: { status: "failed", error: { code: "INVALID_ARGUMENT" } } });
	});

	it("成功模型输出只在顶层包含 provider，并转义 XML", async () => {
		const calls = { count: 0 };
		const result = await executeWebSearch({ query: "Title <pi>&" }, runtime([successProvider("exa_api", calls)]));
		expect(result.details).toMatchObject({ status: "success", provider: "exa_api", cached: false });
		expect(result.content).toContain('query="Title &lt;pi&gt;&amp;"');
		expect(result.content).toContain('provider="exa_api"');
		expect(result.content).toContain("[1] &lt;Title&gt;&amp;");
		expect(result.content).not.toContain("Source:");
		expect(result.content.match(/exa_api/g)).toHaveLength(1);
		expect(calls.count).toBe(1);
	});

	it("每次搜索合并配置和 query 中的域名过滤", async () => {
		let seen: { includeDomains: string[]; excludeDomains: string[] } | undefined;
		const capture: WebSearchProvider = {
			id: "brave_api",
			async search(params) {
				seen = { includeDomains: params.includeDomains, excludeDomains: params.excludeDomains };
				return { status: "failed", provider: "brave_api", details: { status: "failed", provider: "brave_api", error: { code: "ABORTED", message: "stop" } } };
			},
		};
		const rt = runtime([capture]);
		rt.config.websearch.include_domains = ["configured.example"];
		rt.config.websearch.exclude_domains = ["blocked.example"];
		await executeWebSearch({ query: "site:query.example -site:spam.example pi" }, rt);
		expect(seen).toEqual({
			includeDomains: ["configured.example", "query.example"],
			excludeDomains: ["blocked.example", "spam.example"],
		});
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
		const result = await executeWebSearch({ query: "x" }, runtime([failedProvider("exa_api")]));
		expect(result.details).toMatchObject({ status: "failed", response_preview: "secret preview" });
		expect(result.details.status === "failed" ? result.details.attempts?.find((attempt) => attempt.provider === "exa_api") : undefined).toMatchObject({ provider: "exa_api", status: "failed" });
		expect(result.content).toContain('<error tool="websearch" code="HTTP_ERROR">');
		expect(result.content).toContain("failed without secret");
		expect(result.content).not.toContain("secret preview");
		expect(result.content).not.toContain("attempts");
		expect(result.content).not.toContain("\n  ");
	});
});
