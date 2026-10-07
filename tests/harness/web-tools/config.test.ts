import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultCookiePath, loadWebToolsConfig } from "../../../src/harness/web-tools/config.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("o-pi-web-config-");
preserveEnv("PI_WEB_TOOLS_CONFIG", "PI_WEB_TOOLS_COOKIES");
beforeEach(() => {
	process.env.PI_WEB_TOOLS_CONFIG = path.join(temp.path, "config.jsonc");
	delete process.env.PI_WEB_TOOLS_COOKIES;
});
async function save(config: unknown) {
	await writeFile(path.join(temp.path, "config.jsonc"), JSON.stringify(config));
}

describe("网页工具配置", () => {
	it("JSONC 稀疏覆盖保留默认值，域名规范化后仍检查冲突", async () => {
		const defaults = await loadWebToolsConfig();
		await writeFile(path.join(temp.path, "config.jsonc"), '{ // sparse\n"websearch":{"include_domains":["Docs.Example.com", "*.example.org"],},}');
		const config = await loadWebToolsConfig();
		expect(config.webfetch).toEqual(defaults.webfetch);
		expect(config.websearch.include_domains).toEqual(["docs.example.com", "example.org"]);
		await save({ websearch: { include_domains: ["example.org"], exclude_domains: ["*.example.org"] } });
		await expect(loadWebToolsConfig()).rejects.toThrow();
	});

	it("默认顺序来自配置文件，顺序与启停可以分别覆盖", async () => {
		const defaults = await loadWebToolsConfig();
		expect(defaults.websearch.primary_providers).toEqual(["brave_api", "exa_api", "tavily"]);
		expect(defaults.websearch.auxiliary_providers).toEqual(["tinyfish", "anysearch"]);
		expect(defaults.websearch.anysearch).toMatchObject({ enabled: true, api_key: "$ANYSEARCH_API_KEY", max_results: 5, endpoint: "https://api.anysearch.com/v1/search" });
		expect(defaults.websearch.tinyfish).toMatchObject({ api_key: "$TINYFISH_API_KEY", max_results: 5 });
		const order = ["tavily", "exa_api", "brave_api"];
		await save({ websearch: { primary_providers: order, exa_api: { enabled: false } } });
		const config = await loadWebToolsConfig();
		expect(config.websearch.primary_providers).toEqual(order);
		expect(config.websearch.exa_api).toEqual({ ...defaults.websearch.exa_api, enabled: false });
		expect(config.websearch.brave_api).toEqual(defaults.websearch.brave_api);
	});

	it("提供方可调整主辅角色，允许仅使用辅助组且限制独立覆盖", async () => {
		await save({ websearch: {
			primary_providers: [], auxiliary_providers: ["tinyfish", "brave_api", "exa_api", "tavily", "anysearch"],
			default_results: 12, tinyfish: { max_results: 3 },
		} });
		const config = await loadWebToolsConfig();
		expect(config.websearch.primary_providers).toEqual([]);
		expect(config.websearch.auxiliary_providers).toHaveLength(5);
		expect(config.websearch.default_results).toBe(12);
		expect(config.websearch.tinyfish.max_results).toBe(3);
		expect(config.websearch.brave_api.max_results).toBe(5);
	});

	it("配置错误可以修复，外部更改使缓存失效，并发调用不共享可变结果", async () => {
		await save({ webfetch: { unknown: true } });
		await expect(loadWebToolsConfig()).rejects.toThrow();
		await save({ webfetch: { timeout_seconds: 5 } });
		const [first, second] = await Promise.all([loadWebToolsConfig(), loadWebToolsConfig()]);
		first.webfetch.timeout_seconds = 99;
		expect(second.webfetch.timeout_seconds).toBe(5);
		await save({ webfetch: { timeout_seconds: 6 } });
		expect((await loadWebToolsConfig()).webfetch.timeout_seconds).toBe(6);
	});

	it.each([
		{ webfetch: { limits: { find_max_passages: 0 } } },
		{ webfetch: { media: { mode: "invalid" } } },
		{ network: { fake_ip_ranges: ["10.0.0.0/8"] } },
		{ websearch: { exa_api: { endpoint: "file:///secret" } } },
		{ websearch: { primary_providers: [] } },
		{ websearch: { primary_providers: ["brave_api", "exa_api"] } },
		{ websearch: { primary_providers: ["brave_api", "brave_api", "tavily"] } },
		{ websearch: { primary_providers: ["brave_api", "exa_api", "tavily", "unknown"] } },
		{ websearch: { brave_api: { enabled: "false" } } },
		{ websearch: { auxiliary_providers: ["tinyfish", "brave_api"] } },
		{ websearch: { anysearch: { max_results: 0 } } },
		{ websearch: { anysearch: { max_results: 11 } } },
		{ websearch: { anysearch: { endpoint: "http://localhost/" } } },
		{ websearch: { auxiliary_providers: ["tinyfish"] } },
		{ websearch: { tinyfish: { max_results: 0 } } },
		{ websearch: { tinyfish: { max_results: 21 } } },
		{ websearch: { tinyfish: { max_results: 1.5 } } },
		{ websearch: { tinyfish: { endpoint: "http://127.0.0.1/" } } },
		{ websearch: { provider_order: ["brave_api", "exa_api", "tavily"] } },
	])("拒绝非法覆盖 %j", async (config) => {
		await save(config);
		await expect(loadWebToolsConfig()).rejects.toThrow();
	});

	it.each([
		{ enabled: true },
		{ enabled: true, http_proxy: "socks5://127.0.0.1:1080" },
		{ enabled: true, socks5_proxy: "http://127.0.0.1:8080" },
		{ enabled: true, https_proxy: "http://127.0.0.1:8080/path" },
		{ enabled: true, http_proxy: "http://127.0.0.1:0" },
	])("拒绝不能使用的代理 %j", async (proxy) => {
		await save({ network: { proxy } });
		await expect(loadWebToolsConfig()).rejects.toThrow();
	});

	it("显式代理和 fake-IP 配置可用，Cookie 路径可单独覆盖", async () => {
		const network = {
			proxy: { enabled: true, http_proxy: "http://127.0.0.1:7890", socks5_proxy: "socks5://127.0.0.1:7891" },
			fake_ip_ranges: ["198.18.0.0/16"],
		};
		await save({ network });
		expect((await loadWebToolsConfig()).network).toMatchObject(network);
		process.env.PI_WEB_TOOLS_COOKIES = path.join(temp.path, "cookies.txt");
		expect(defaultCookiePath()).toBe(process.env.PI_WEB_TOOLS_COOKIES);
	});

	it.each(["http://127.0.0.1:3000/mcp", "http://localhost:3000/mcp", "http://192.168.1.1/mcp", "https://user:pass@example.com/mcp"])(
		"搜索端点拒绝私网和凭据 URL %s", async (endpoint) => {
			await save({ websearch: { exa_api: { endpoint } } });
			await expect(loadWebToolsConfig()).rejects.toThrow();
		},
	);
});
