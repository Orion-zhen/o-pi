import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultCookiePath, defaultWebToolsConfig, loadWebToolsConfig } from "../src/web-tools/config.js";

let dir: string;
const previousConfig = process.env.PI_WEB_TOOLS_CONFIG;
const previousCookies = process.env.PI_WEB_TOOLS_COOKIES;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "o-pi-web-config-"));
	delete process.env.PI_WEB_TOOLS_CONFIG;
	delete process.env.PI_WEB_TOOLS_COOKIES;
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	if (previousConfig === undefined) delete process.env.PI_WEB_TOOLS_CONFIG;
	else process.env.PI_WEB_TOOLS_CONFIG = previousConfig;
	if (previousCookies === undefined) delete process.env.PI_WEB_TOOLS_COOKIES;
	else process.env.PI_WEB_TOOLS_COOKIES = previousCookies;
});

describe("web-tools config", () => {
	it("缺少配置文件采用默认值", async () => {
		process.env.PI_WEB_TOOLS_CONFIG = path.join(dir, "missing.jsonc");
		expect(await loadWebToolsConfig()).toEqual(defaultWebToolsConfig());
	});

	it("支持合法 JSONC 和 trailing comma", async () => {
		const file = path.join(dir, "web-tools.jsonc");
		await writeFile(
			file,
			`{
				"$schema": "../schemas/web-tools.schema.json",
				"version": 2,
				"network": { "fake_ip_ranges": ["198.18.0.0/16"], },
				"websearch": { "default_results": 5, "region": "us-en", },
				"webfetch": {
					"timeout_seconds": 5,
					"limits": { "default_output_chars": 1000, "max_output_chars": 2000, },
					"cookies": { "domains": ["example.com"], "confirmation": "never", },
				},
			}`,
		);
		process.env.PI_WEB_TOOLS_CONFIG = file;
		expect(await loadWebToolsConfig()).toMatchObject({
			network: { fake_ip_ranges: ["198.18.0.0/16"] },
			websearch: { default_results: 5, region: "us-en" },
			webfetch: {
				timeout_seconds: 5,
				limits: { default_output_chars: 1000, max_output_chars: 2000 },
				cookies: { domains: ["example.com"], confirmation: "never" },
			},
		});
	});

	it("拒绝未知字段、非法 enum 和语义错误", async () => {
		const file = path.join(dir, "bad.jsonc");
		process.env.PI_WEB_TOOLS_CONFIG = file;
		await writeFile(file, '{ "version": 2, "webfetch": { "unknown": true } }');
		await expect(loadWebToolsConfig()).rejects.toThrow("does not match schema");

		await writeFile(file, '{ "version": 2, "webfetch": { "cookies": { "confirmation": "sometimes" } } }');
		await expect(loadWebToolsConfig()).rejects.toThrow("does not match schema");

		await writeFile(file, '{ "version": 2, "webfetch": { "limits": { "default_output_chars": 2000, "max_output_chars": 1000 } } }');
		await expect(loadWebToolsConfig()).rejects.toThrow("default_output_chars");

		await writeFile(file, '{ "version": 2, "network": { "fake_ip_ranges": ["10.0.0.0/8"] } }');
		await expect(loadWebToolsConfig()).rejects.toThrow("does not match schema");

		await writeFile(file, '{ "version": 2, "network": { "fake_ip_ranges": ["198.18.0.0/16"] } }');
		await expect(loadWebToolsConfig()).resolves.toMatchObject({ network: { fake_ip_ranges: ["198.18.0.0/16"] } });
	});

	it("环境变量覆盖 Cookie 路径", () => {
		process.env.PI_WEB_TOOLS_COOKIES = path.join(dir, "cookies.txt");
		expect(defaultCookiePath()).toBe(path.join(dir, "cookies.txt"));
	});
});
