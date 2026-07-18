import { readFile, realpath, stat } from "node:fs/promises";
import { Cookie, CookieJar } from "tough-cookie";

import type { CookieAccess, CookieStore, WebFetchFailureDetails } from "./types.js";

interface LoadedCookies {
	realpath: string;
	mtimeMs: number;
	size: number;
	jar: CookieJar;
	fingerprint: string;
}

export class NetscapeCookieStore implements CookieStore {
	private loaded: LoadedCookies | undefined;

	constructor(private readonly cookiePath: string) {}

	/** 返回当前 URL 可发送的 Cookie header；明文名称和值只留在内存和请求头中。 */
	async getCookieAccess(url: URL, allowlisted: boolean): Promise<CookieAccess | WebFetchFailureDetails> {
		if (!allowlisted) return { fingerprint: "disabled", authenticated: false };
		const loaded = await this.load();
		if ("status" in loaded) return loaded;
		const header = await loaded.jar.getCookieString(url.toString(), { http: true });
		return {
			...(header.length > 0 ? { header } : {}),
			fingerprint: `${loaded.fingerprint}:${header.length > 0 ? "with-cookie" : "empty"}`,
			authenticated: header.length > 0,
		};
	}

	async storeFromResponse(url: URL, setCookieHeaders: string[], allowlisted: boolean): Promise<WebFetchFailureDetails | undefined> {
		if (!allowlisted || setCookieHeaders.length === 0) return undefined;
		const loaded = await this.load();
		if ("status" in loaded) return loaded;
		for (const header of setCookieHeaders) {
			try {
				await loaded.jar.setCookie(header, url.toString(), { ignoreError: true, http: true });
			} catch {
				// 单个 Set-Cookie 格式不合规时忽略；远端响应不能使已有登录态整体失效。
			}
		}
		return undefined;
	}

	private async load(): Promise<LoadedCookies | WebFetchFailureDetails> {
		let fileStat;
		let resolved: string;
		try {
			fileStat = await stat(this.cookiePath);
			resolved = await realpath(this.cookiePath);
		} catch (error) {
			if (isNotFound(error)) {
				const jar = new CookieJar(undefined, { rejectPublicSuffixes: true });
				return {
					realpath: this.cookiePath,
					mtimeMs: 0,
					size: 0,
					jar,
					fingerprint: "missing",
				};
			}
			return cookieError("cookies.txt cannot be read.");
		}
		if (!fileStat.isFile()) return cookieError("cookies.txt must be a regular file.");
		if (process.platform !== "win32" && (fileStat.mode & 0o077) !== 0) {
			return cookieError("cookies.txt must not be readable by group or other users.");
		}
		if (
			this.loaded !== undefined &&
			this.loaded.realpath === resolved &&
			this.loaded.mtimeMs === fileStat.mtimeMs &&
			this.loaded.size === fileStat.size
		) {
			return this.loaded;
		}

		let text: string;
		try {
			text = await readFile(this.cookiePath, "utf8");
		} catch {
			return cookieError("cookies.txt cannot be read.");
		}
		const jar = new CookieJar(undefined, { rejectPublicSuffixes: true });
		for (const line of text.split(/\r?\n/)) {
			const cookie = parseNetscapeCookieLine(line);
			if (cookie === undefined) continue;
			try {
				await jar.setCookie(cookie.cookie, cookie.url, { ignoreError: true, http: true });
			} catch {
				return cookieError("cookies.txt contains an invalid cookie.");
			}
		}
		this.loaded = {
			realpath: resolved,
			mtimeMs: fileStat.mtimeMs,
			size: fileStat.size,
			jar,
			fingerprint: `${fileStat.mtimeMs}:${fileStat.size}`,
		};
		return this.loaded;
	}
}

function parseNetscapeCookieLine(line: string): { cookie: Cookie; url: string } | undefined {
	if (line.trim() === "" || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) return undefined;
	const httpOnly = line.startsWith("#HttpOnly_");
	const normalizedLine = httpOnly ? line.slice("#HttpOnly_".length) : line;
	const fields = normalizedLine.split("\t");
	if (fields.length !== 7) return undefined;
	const [domainField, includeSubdomains, rawPath, secureField, expiresField, name, value] = fields;
	if (
		domainField === undefined ||
		includeSubdomains === undefined ||
		rawPath === undefined ||
		secureField === undefined ||
		expiresField === undefined ||
		name === undefined ||
		value === undefined
	) {
		return undefined;
	}
	const includeSubs = includeSubdomains.toUpperCase() === "TRUE";
	const secure = secureField.toUpperCase() === "TRUE";
	const domain = domainField.replace(/^\./, "");
	const expires = Number(expiresField);
	const expiresValue: Date | "Infinity" = expires > 0 ? new Date(expires * 1000) : "Infinity";
	const cookieOptions = {
		key: name,
		value,
		path: rawPath || "/",
		secure,
		httpOnly,
		expires: expiresValue,
		...(includeSubs ? { domain } : {}),
	};
	const cookie = new Cookie(cookieOptions);
	const protocol = secure ? "https" : "http";
	return { cookie, url: `${protocol}://${domain}${rawPath.startsWith("/") ? rawPath : "/"}` };
}

function cookieError(message: string): WebFetchFailureDetails {
	return { status: "failed", error: { code: "COOKIE_ERROR", message } };
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
