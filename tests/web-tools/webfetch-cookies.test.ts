import { chmod, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { matchesDomainRule } from "../../src/web-tools/network/url-utils.js";
import { NetscapeCookieStore } from "../../src/web-tools/fetch/cookie-store.js";
import { Agent } from "undici";
import * as configModule from "../../src/web-tools/config.js";
import { createWebFetchRuntime } from "../../src/web-tools/fetch/webfetch-runtime.js";
import { defaultWebToolsConfig } from "./config-fixture.js";
import { httpResponse } from "../helpers/http.js";
import { useTempDir } from "../helpers/lifecycle.js";

let dir: string;
const temp = useTempDir("o-pi-web-cookies-");

beforeEach(() => {
	dir = temp.path;
});

describe("webfetch cookies", () => {
	it("实现 exact 和 wildcard allowlist 语义", () => {
		expect(matchesDomainRule("example.com", ["example.com"])).toBe(true);
		expect(matchesDomainRule("a.example.com", ["example.com"])).toBe(false);
		expect(matchesDomainRule("a.example.com", ["*.example.com"])).toBe(true);
		expect(matchesDomainRule("example.com", ["*.example.com"])).toBe(false);
	});

	it("只在 allowlist 命中且需要 Cookie 时加载 store，并复用并发加载", async () => {
		const config = defaultWebToolsConfig();
		config.webfetch.cookies = { enabled: true, domains: ["example.com"], confirmation: "never" };
		const loadPath = vi.spyOn(configModule, "defaultCookiePath").mockReturnValue(path.join(dir, "missing.txt"));
		const dispatcher = new Agent();
		const runtime = createWebFetchRuntime({
			getDispatcher: async () => dispatcher,
			fetchImpl: async () => httpResponse(200, "page", { "content-type": "text/plain" }),
			loadConfig: async () => config,
			now: () => Date.now(),
		});
		try {
			await runtime.fetch({ url: "https://other.com/" }, { toolCallId: "public" });
			expect(loadPath).not.toHaveBeenCalled();
			const results = await Promise.all([
				runtime.fetch({ url: "https://example.com/one" }, { toolCallId: "cookie-1" }),
				runtime.fetch({ url: "https://example.com/two" }, { toolCallId: "cookie-2" }),
			]);
			expect(results.every((result) => result.details.status === "success")).toBe(true);
			expect(loadPath).toHaveBeenCalledTimes(1);
		} finally {
			await runtime.close();
			await dispatcher.close();
			loadPath.mockRestore();
		}
	});

	it("解析 Netscape 和 HttpOnly 行，并按 domain/path/secure 匹配", async () => {
		const file = path.join(dir, "cookies.txt");
		await writeFile(
			file,
			[
				"# Netscape HTTP Cookie File",
				".example.com\tTRUE\t/docs\tTRUE\t0\tsid\tsecret",
				"#HttpOnly_example.com\tFALSE\t/\tFALSE\t0\thost\tvalue",
			].join("\n"),
		);
		if (process.platform !== "win32") await chmod(file, 0o600);
		const store = new NetscapeCookieStore(file);

		const docs = await store.getCookieAccess(new URL("https://a.example.com/docs/page"));
		expect("header" in docs ? docs.header : "").toContain("sid=secret");

		const hostOnly = await store.getCookieAccess(new URL("http://example.com/"));
		expect("header" in hostOnly ? hostOnly.header : "").toContain("host=value");

		const crossDomain = await store.getCookieAccess(new URL("https://other.com/docs"));
		expect(crossDomain).toEqual({});
	});

	it("Set-Cookie 只更新内存，文件变更后按磁盘重新加载", async () => {
		const file = path.join(dir, "cookies.txt");
		await writeFile(file, ".example.com\tTRUE\t/\tFALSE\t0\ta\t1\n");
		if (process.platform !== "win32") await chmod(file, 0o600);
		const store = new NetscapeCookieStore(file);
		await store.storeFromResponse(new URL("http://example.com/"), ["b=2; Path=/"]);
		expect("header" in await store.getCookieAccess(new URL("http://example.com/"))).toBe(true);

		const later = new Date(Date.now() + 2000);
		await writeFile(file, ".example.com\tTRUE\t/\tFALSE\t0\ta\t3\n");
		await utimes(file, later, later);
		const reloaded = await store.getCookieAccess(new URL("http://example.com/"));
		expect("header" in reloaded ? reloaded.header : "").toContain("a=3");
		expect("header" in reloaded ? reloaded.header : "").not.toContain("b=2");
	});

	it.skipIf(process.platform === "win32")("Cookie 文件权限不安全时 fail closed", async () => {
		const file = path.join(dir, "cookies.txt");
		await writeFile(file, ".example.com\tTRUE\t/\tFALSE\t0\ta\t1\n");
		await chmod(file, 0o644);
		expect(await stat(file)).toBeTruthy();
		expect(await new NetscapeCookieStore(file).getCookieAccess(new URL("http://example.com/"))).toMatchObject({
			status: "failed",
			error: { code: "COOKIE_ERROR" },
		});
	});
});
