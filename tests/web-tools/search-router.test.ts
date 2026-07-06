import { describe, expect, it } from "vitest";

import { defaultWebToolsConfig } from "../../src/web-tools/config.js";
import { SearchProviderRouter } from "../../src/web-tools/search-providers/router.js";
import type { SearchProviderResult, WebSearchProvider } from "../../src/web-tools/search-providers/types.js";
import type { WebSearchProviderId } from "../../src/web-tools/types.js";

function provider(id: WebSearchProviderId, result: SearchProviderResult, calls: string[]): WebSearchProvider {
	return {
		id,
		async search() {
			calls.push(id);
			return result;
		},
	};
}

function success(id: WebSearchProviderId): SearchProviderResult {
	return { status: "success", provider: id, downloadedBytes: 1, results: [{ rank: 1, title: id, url: `https://${id}.test/` }] };
}

function failed(id: WebSearchProviderId, code: "MCP_ERROR" | "TIMEOUT" = "MCP_ERROR"): SearchProviderResult {
	return {
		status: "failed",
		provider: id,
		details: { status: "failed", provider: id, error: { code, message: code }, query: "pi" },
	};
}

function skipped(id: WebSearchProviderId): SearchProviderResult {
	return { status: "skipped", provider: id, reason: "provider disabled" };
}

describe("search provider router", () => {
	it("Exa 成功时不调用 DDG", async () => {
		const calls: string[] = [];
		const config = defaultWebToolsConfig().websearch;
		const router = new SearchProviderRouter([provider("exa_mcp", success("exa_mcp"), calls), provider("duckduckgo_html", success("duckduckgo_html"), calls)], config);
		const result = await router.search({ query: "pi", limit: 1 }, { now: () => 0 });
		expect(result).toMatchObject({ status: "success", provider: "exa_mcp" });
		expect(calls).toEqual(["exa_mcp"]);
	});

	it("Exa 失败或超时后 fallback 到 DDG", async () => {
		const calls: string[] = [];
		const config = defaultWebToolsConfig().websearch;
		const router = new SearchProviderRouter([provider("exa_mcp", failed("exa_mcp", "TIMEOUT"), calls), provider("duckduckgo_html", success("duckduckgo_html"), calls)], config);
		const result = await router.search({ query: "pi", limit: 1 }, { now: () => 0 });
		expect(result).toMatchObject({ status: "success", provider: "duckduckgo_html", attempts: [{ provider: "exa_mcp", status: "failed" }, { provider: "duckduckgo_html", status: "success" }] });
		expect(calls).toEqual(["exa_mcp", "duckduckgo_html"]);
	});

	it("provider skipped、fallback false 和全部失败", async () => {
		const config = defaultWebToolsConfig().websearch;
		config.provider_order = ["exa_mcp", "duckduckgo_html"];
		let calls: string[] = [];
		let router = new SearchProviderRouter([provider("exa_mcp", skipped("exa_mcp"), calls), provider("duckduckgo_html", success("duckduckgo_html"), calls)], config);
		await expect(router.search({ query: "pi", limit: 1 }, { now: () => 0 })).resolves.toMatchObject({ status: "success", provider: "duckduckgo_html" });
		expect(calls).toEqual(["exa_mcp", "duckduckgo_html"]);

		calls = [];
		config.fallback = false;
		router = new SearchProviderRouter([provider("exa_mcp", failed("exa_mcp"), calls), provider("duckduckgo_html", success("duckduckgo_html"), calls)], config);
		await expect(router.search({ query: "pi", limit: 1 }, { now: () => 0 })).resolves.toMatchObject({ status: "failed", details: { error: { code: "MCP_ERROR" } } });
		expect(calls).toEqual(["exa_mcp"]);

		calls = [];
		config.fallback = true;
		router = new SearchProviderRouter([provider("exa_mcp", failed("exa_mcp"), calls), provider("duckduckgo_html", failed("duckduckgo_html"), calls)], config);
		await expect(router.search({ query: "pi", limit: 1 }, { now: () => 0 })).resolves.toMatchObject({
			status: "failed",
			details: { error: { code: "MCP_ERROR" }, attempts: [{ provider: "exa_mcp" }, { provider: "duckduckgo_html" }] },
		});
	});

	it("全部 provider skipped 时返回 NO_PROVIDER_AVAILABLE", async () => {
		const calls: string[] = [];
		const config = defaultWebToolsConfig().websearch;
		const router = new SearchProviderRouter([provider("exa_mcp", skipped("exa_mcp"), calls), provider("duckduckgo_html", skipped("duckduckgo_html"), calls)], config);
		await expect(router.search({ query: "pi", limit: 1 }, { now: () => 0 })).resolves.toMatchObject({
			status: "failed",
			details: { error: { code: "NO_PROVIDER_AVAILABLE" } },
		});
	});
});
