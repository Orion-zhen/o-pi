import { chmod, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isCookieAllowed } from "../../src/web-tools/cookie-policy.js";
import { NetscapeCookieStore } from "../../src/web-tools/cookie-store.js";
import type { CookieStore } from "../../src/web-tools/types.js";
import { createLazyCookieStore } from "../../src/web-tools/webfetch-runtime.js";
import { useTempDir } from "../helpers/lifecycle.js";

let dir: string;
const temp = useTempDir("o-pi-web-cookies-");

beforeEach(() => {
	dir = temp.path;
});

describe("webfetch cookies", () => {
	it("实现 exact 和 wildcard allowlist 语义", () => {
		expect(isCookieAllowed("example.com", ["example.com"])).toBe(true);
		expect(isCookieAllowed("a.example.com", ["example.com"])).toBe(false);
		expect(isCookieAllowed("a.example.com", ["*.example.com"])).toBe(true);
		expect(isCookieAllowed("example.com", ["*.example.com"])).toBe(false);
	});

	it("只在 allowlist 命中且需要 Cookie 时加载 store，并复用并发加载", async () => {
		const store: CookieStore = {
			async getCookieAccess() {
				return { fingerprint: "loaded", authenticated: false };
			},
			async storeFromResponse() {
				return undefined;
			},
		};
		const load = vi.fn(async () => store);
		const lazy = createLazyCookieStore(load);

		await lazy.getCookieAccess(new URL("https://example.com/"), false);
		await lazy.storeFromResponse(new URL("https://example.com/"), [], true);
		expect(load).not.toHaveBeenCalled();
		await Promise.all([
			lazy.getCookieAccess(new URL("https://example.com/"), true),
			lazy.getCookieAccess(new URL("https://example.com/"), true),
		]);
		expect(load).toHaveBeenCalledTimes(1);
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

		const docs = await store.getCookieAccess(new URL("https://a.example.com/docs/page"), true);
		expect(docs).toMatchObject({ authenticated: true });
		expect("header" in docs ? docs.header : "").toContain("sid=secret");

		const hostOnly = await store.getCookieAccess(new URL("http://example.com/"), true);
		expect("header" in hostOnly ? hostOnly.header : "").toContain("host=value");

		const crossDomain = await store.getCookieAccess(new URL("https://other.com/docs"), true);
		expect(crossDomain).toMatchObject({ authenticated: false });
	});

	it("Set-Cookie 只更新内存，文件变更后按磁盘重新加载", async () => {
		const file = path.join(dir, "cookies.txt");
		await writeFile(file, ".example.com\tTRUE\t/\tFALSE\t0\ta\t1\n");
		if (process.platform !== "win32") await chmod(file, 0o600);
		const store = new NetscapeCookieStore(file);
		await store.storeFromResponse(new URL("http://example.com/"), ["b=2; Path=/"], true);
		expect((await store.getCookieAccess(new URL("http://example.com/"), true)).authenticated).toBe(true);
		expect("header" in await store.getCookieAccess(new URL("http://example.com/"), true)).toBe(true);

		const later = new Date(Date.now() + 2000);
		await writeFile(file, ".example.com\tTRUE\t/\tFALSE\t0\ta\t3\n");
		await utimes(file, later, later);
		const reloaded = await store.getCookieAccess(new URL("http://example.com/"), true);
		expect("header" in reloaded ? reloaded.header : "").toContain("a=3");
		expect("header" in reloaded ? reloaded.header : "").not.toContain("b=2");
	});

	it.skipIf(process.platform === "win32")("Cookie 文件权限不安全时 fail closed", async () => {
		const file = path.join(dir, "cookies.txt");
		await writeFile(file, ".example.com\tTRUE\t/\tFALSE\t0\ta\t1\n");
		await chmod(file, 0o644);
		expect(await stat(file)).toBeTruthy();
		expect(await new NetscapeCookieStore(file).getCookieAccess(new URL("http://example.com/"), true)).toMatchObject({
			status: "failed",
			error: { code: "COOKIE_ERROR" },
		});
	});
});
