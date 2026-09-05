import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { defaultCookiePath, loadWebToolsConfig } from "../../src/web-tools/config.js";
import { defaultWebToolsConfig } from "./config-fixture.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let dir: string;
const temp = useTempDir("o-pi-web-config-");
preserveEnv("PI_WEB_TOOLS_CONFIG", "PI_WEB_TOOLS_COOKIES");

beforeEach(() => {
	dir = temp.path;
	delete process.env.PI_WEB_TOOLS_CONFIG;
	delete process.env.PI_WEB_TOOLS_COOKIES;
});

describe("web-tools config", () => {
	it("缺少配置文件采用默认值", async () => {
		process.env.PI_WEB_TOOLS_CONFIG = path.join(dir, "missing.jsonc");
		const config = await loadWebToolsConfig();
		expect(config).toEqual(defaultWebToolsConfig());
		expect(Object.keys(config).sort()).toEqual(["network", "webfetch", "websearch"]);
		expect(config.network.proxy).toEqual({
			enabled: false,
			http_proxy: "",
			https_proxy: "",
			socks5_proxy: "",
		});
	});

	it("支持合法 JSONC 和 trailing comma", async () => {
		const file = path.join(dir, "web-tools.jsonc");
		await writeFile(
			file,
			`{
				"$schema": "../schemas/web-tools.schema.json",
				"network": {
					"proxy": {
						"enabled": true,
						"http_proxy": "http://127.0.0.1:7890",
						"https_proxy": "https://proxy.example:8443",
						"socks5_proxy": "socks5://127.0.0.1:7891",
					},
					"fake_ip_ranges": ["198.18.0.0/16"],
				},
				"websearch": {
					"default_results": 5,
					"total_deadline_seconds": 18,
					"include_domains": ["Docs.Example.com", "*.example.org"],
					"exclude_domains": ["spam.example"],
					"brave_api": { "api_key": "literal-key", },
					"duckduckgo_html": { "region": "us-en", },
				},
				"webfetch": {
					"timeout_seconds": 5,
					"readability": { "char_threshold": 800, },
					"media": { "mode": "off", "response_bytes": 1048576, },
					"limits": { "default_output_chars": 1000, },
					"cookies": { "domains": ["example.com"], "confirmation": "never", },
				},
			}`,
		);
		process.env.PI_WEB_TOOLS_CONFIG = file;
		expect(await loadWebToolsConfig()).toMatchObject({
			network: {
				proxy: {
					enabled: true,
					http_proxy: "http://127.0.0.1:7890",
					https_proxy: "https://proxy.example:8443",
					socks5_proxy: "socks5://127.0.0.1:7891",
				},
				fake_ip_ranges: ["198.18.0.0/16"],
			},
			websearch: {
				default_results: 5,
				total_deadline_seconds: 18,
				include_domains: ["docs.example.com", "example.org"],
				exclude_domains: ["spam.example"],
				brave_api: { api_key: "literal-key" },
				duckduckgo_html: { region: "us-en" },
			},
			webfetch: {
				timeout_seconds: 5,
				readability: { char_threshold: 800 },
				media: { mode: "off", response_bytes: 1048576 },
				limits: { default_output_chars: 1000 },
				cookies: { domains: ["example.com"], confirmation: "never" },
			},
		});
	});

	it("复用未变化配置，返回隔离副本并在文件变更后失效", async () => {
		const file = path.join(dir, "cached.jsonc");
		process.env.PI_WEB_TOOLS_CONFIG = file;
		await writeFile(file, '{ "webfetch": { "timeout_seconds": 5 } }');

		const [first, concurrent] = await Promise.all([loadWebToolsConfig(), loadWebToolsConfig()]);
		first.webfetch.timeout_seconds = 99;
		expect(concurrent.webfetch.timeout_seconds).toBe(5);
		expect((await loadWebToolsConfig()).webfetch.timeout_seconds).toBe(5);

		await writeFile(file, '{ "webfetch": { "timeout_seconds": 6 } }');
		expect((await loadWebToolsConfig()).webfetch.timeout_seconds).toBe(6);
	});

	it("拒绝未知字段、非法 enum 和语义错误", async () => {
		const file = path.join(dir, "bad.jsonc");
		process.env.PI_WEB_TOOLS_CONFIG = file;
		await writeFile(file, '{ "webfetch": { "unknown": true } }');
		await expect(loadWebToolsConfig()).rejects.toThrow("does not match schema");

		await writeFile(file, '{ "webfetch": { "cookies": { "confirmation": "sometimes" } } }');
		await expect(loadWebToolsConfig()).rejects.toThrow("does not match schema");

		await writeFile(file, '{ "webfetch": { "readability": { "char_threshold": 0 } } }');
		await expect(loadWebToolsConfig()).rejects.toThrow("does not match schema");

		await writeFile(file, '{ "webfetch": { "media": { "max_images": 1 } } }');
		await expect(loadWebToolsConfig()).rejects.toThrow("does not match schema");

		await writeFile(file, '{ "network": { "fake_ip_ranges": ["10.0.0.0/8"] } }');
		await expect(loadWebToolsConfig()).rejects.toThrow("does not match schema");

		await writeFile(file, '{ "network": { "fake_ip_ranges": ["198.18.0.0/16"] } }');
		await expect(loadWebToolsConfig()).resolves.toMatchObject({ network: { fake_ip_ranges: ["198.18.0.0/16"] } });

		await writeFile(file, '{ "network": { "proxy": { "unknown": true } } }');
		await expect(loadWebToolsConfig()).rejects.toThrow("does not match schema");
	});

	it.each([
		[
			"没有端点",
			{ network: { proxy: { enabled: true } } },
			"network.proxy.enabled requires at least one proxy endpoint",
		],
		[
			"HTTP 字段使用 SOCKS5 协议",
			{ network: { proxy: { enabled: true, http_proxy: "socks5://127.0.0.1:1080" } } },
			"network.proxy.http_proxy must be a valid proxy URL",
		],
		[
			"SOCKS5 字段使用 HTTP 协议",
			{ network: { proxy: { enabled: true, socks5_proxy: "http://127.0.0.1:8080" } } },
			"network.proxy.socks5_proxy must be a valid proxy URL",
		],
		[
			"代理 URL 带路径",
			{ network: { proxy: { enabled: true, https_proxy: "http://127.0.0.1:8080/path" } } },
			"network.proxy.https_proxy must be a valid proxy URL",
		],
		[
			"代理 URL 使用零端口",
			{ network: { proxy: { enabled: true, http_proxy: "http://127.0.0.1:0" } } },
			"network.proxy.http_proxy must be a valid proxy URL",
		],
	] as const)("拒绝非法代理配置：%s", async (_label, value, message) => {
		const file = path.join(dir, "proxy.jsonc");
		process.env.PI_WEB_TOOLS_CONFIG = file;
		await writeFile(file, JSON.stringify(value));
		await expect(loadWebToolsConfig()).rejects.toThrow(message);
	});

	it("提供搜索默认值并拒绝未知字段和非法 endpoint", async () => {
		const file = path.join(dir, "search.jsonc");
		process.env.PI_WEB_TOOLS_CONFIG = file;
		await writeFile(file, '{}');
		const defaults = defaultWebToolsConfig();
		await expect(loadWebToolsConfig()).resolves.toMatchObject({
			websearch: {
				include_domains: defaults.websearch.include_domains,
				exclude_domains: defaults.websearch.exclude_domains,
				brave_api: { api_key: "$BRAVE_SEARCH_API_KEY" },
				exa_api: { api_key: "$EXA_API_KEY" },
				tavily: { api_key: "$TAVILY_API_KEY" },
			},
		});
		expect(JSON.stringify(await loadWebToolsConfig())).not.toContain("secret-key");

		await writeFile(file, '{ "websearch": { "unknown_router_field": true } }');
		await expect(loadWebToolsConfig()).rejects.toThrow("does not match schema");

		const fileEndpoint = pathToFileURL(path.join(dir, "key")).toString();
		await writeFile(file, JSON.stringify({ websearch: { exa_api: { endpoint: fileEndpoint } } }));
		await expect(loadWebToolsConfig()).rejects.toThrow("does not match schema");

		await writeFile(file, '{ "websearch": { "brave_api": { "api_key": "" } } }');
		await expect(loadWebToolsConfig()).resolves.toMatchObject({ websearch: { brave_api: { api_key: "" } } });

		await writeFile(file, '{ "websearch": { "include_domains": ["example.com"], "exclude_domains": ["*.example.com"] } }');
		await expect(loadWebToolsConfig()).rejects.toThrow("include_domains and exclude_domains must not overlap");
	});

	it("provider endpoint 拒绝 localhost、private literal IP 和 userinfo", async () => {
		const file = path.join(dir, "exa-url.jsonc");
		process.env.PI_WEB_TOOLS_CONFIG = file;

		await writeFile(file, '{ "websearch": { "exa_api": { "endpoint": "https://api.exa.ai/search" } } }');
		await expect(loadWebToolsConfig()).resolves.toMatchObject({ websearch: { exa_api: { endpoint: "https://api.exa.ai/search" } } });

		for (const url of [
			"http://127.0.0.1:3000/mcp",
			"http://localhost:3000/mcp",
			"http://192.168.1.1/mcp",
			"https://user:pass@example.com/mcp",
		]) {
			await writeFile(file, JSON.stringify({ websearch: { exa_api: { endpoint: url } } }));
			await expect(loadWebToolsConfig()).rejects.toThrow("exa_api.endpoint is not an allowed public HTTP URL");
		}
	});

	it("环境变量覆盖 Cookie 路径", () => {
		process.env.PI_WEB_TOOLS_COOKIES = path.join(dir, "cookies.txt");
		expect(defaultCookiePath()).toBe(path.join(dir, "cookies.txt"));
	});
});
