import { describe, expect, it } from "vitest";

import { providerSignature, SearchFlights, searchFlightKey } from "../../src/web-tools/search/search-flights.js";
import { defaultWebToolsConfig } from "./config-fixture.js";
import { preserveEnv } from "../helpers/lifecycle.js";

preserveEnv("WEBSEARCH_SIGNATURE_KEY");

describe("websearch singleflight", () => {
	it("相同 in-flight 请求 singleflight，完成后允许重新执行", async () => {
		const cache = new SearchFlights();
		let calls = 0;
		const result = { status: "success" as const, provider: "brave_api" as const, results: [{ rank: 1, title: "Pi", url: "https://example.com/pi" }], downloadedBytes: 42, attempts: [] };
		let release: (() => void) | undefined;
		const task = () => cache.run("same", async () => { calls += 1; await new Promise<void>((resolve) => { release = resolve; }); return result; });
		const first = task();
		const second = task();
		expect(calls).toBe(1);
		release?.();
		await expect(Promise.all([first, second])).resolves.toEqual([result, result]);
		const third = cache.run("same", async () => { calls += 1; return result; });
		await expect(third).resolves.toEqual(result);
		expect(calls).toBe(2);
	});

	it("singleflight key 包含 query、limit 和 provider 签名", () => {
		const config = defaultWebToolsConfig().websearch;
		const changed = defaultWebToolsConfig().websearch;
		changed.duckduckgo_html.region = "us-en";
		expect(searchFlightKey(" pi ", 8, config).startsWith(["pi", "8"].join("\0"))).toBe(true);
		expect(searchFlightKey("pi", 2, config)).not.toBe(searchFlightKey("pi", 8, config));
		expect(searchFlightKey("pi", 8, changed)).not.toBe(searchFlightKey("pi", 8, config));
	});

	it("provider 签名响应 key 变化但不包含密钥", () => {
		const config = defaultWebToolsConfig().websearch;
		config.brave_api.api_key = "literal-secret";
		const literal = providerSignature(config);
		expect(literal).not.toContain("literal-secret");

		config.brave_api.api_key = "$WEBSEARCH_SIGNATURE_KEY";
		process.env.WEBSEARCH_SIGNATURE_KEY = "first-secret";
		const first = providerSignature(config);
		process.env.WEBSEARCH_SIGNATURE_KEY = "second-secret";
		const second = providerSignature(config);
		expect(second).not.toBe(first);
		expect(second).not.toContain("second-secret");
	});
});
