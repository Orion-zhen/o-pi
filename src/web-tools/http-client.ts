import type { Dispatcher } from "undici";

import type { CookieStore, HttpFetchResult, WebFetchExecutionContext, WebToolsConfig, WebFetchFailureDetails, WebHttpFetch, WebHttpResponse, WebHttpHeaders } from "./types.js";
import { isCookieAllowed } from "./cookie-store.js";
import { validateRequestUrl } from "./network-policy.js";
import { readLimitedResponseBody, responseContentLength } from "./response-body.js";
import { originKey, redactUrl } from "./url-utils.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ACCEPT_HEADER = "text/markdown, text/plain;q=0.9, application/json;q=0.9, application/xml;q=0.8, text/html;q=0.8, */*;q=0.1";

export interface HttpClientOptions {
	dispatcher: Dispatcher;
	fetchImpl: WebHttpFetch;
	cookieStore: CookieStore;
	approvedAuthOrigins: Set<string>;
	config: WebToolsConfig;
	context: WebFetchExecutionContext;
	startedAt: number;
	now: () => number;
}

export async function fetchHttpUrl(rawUrl: string, options: HttpClientOptions): Promise<HttpFetchResult> {
	const fetchImpl = options.fetchImpl;
	const requested = validateRequestUrl(rawUrl);
	if ("status" in requested) {
		return { status: "failed", details: { ...requested, requested_url: safeRedact(rawUrl), duration_ms: elapsed(options) } };
	}

	let currentUrl = requested.url;
	let redirectCount = 0;
	let authenticated = false;
	let lastStatus: number | undefined;

	while (true) {
		const checked = validateRequestUrl(currentUrl.toString());
		if ("status" in checked) {
			return {
				status: "failed",
				details: {
					...checked,
					requested_url: requested.displayUrl,
					final_url: safeRedact(currentUrl.toString()),
					...(lastStatus !== undefined ? { http_status: lastStatus } : {}),
					authenticated,
					redirect_count: redirectCount,
					duration_ms: elapsed(options),
				},
			};
		}
		currentUrl = checked.url;
		options.context.onUpdate?.({
			content: redirectCount > 0 ? "Redirecting..." : "Requesting...",
			details: { status: "progress", phase: redirectCount > 0 ? "redirecting" : "requesting", redirect_count: redirectCount },
		});

		const allowlisted = options.config.webfetch.cookies.enabled && isCookieAllowed(currentUrl.hostname, options.config.webfetch.cookies.domains);
		const cookieAccess = await options.cookieStore.getCookieAccess(currentUrl, allowlisted);
		if ("status" in cookieAccess) {
			return { status: "failed", details: withRequest(cookieAccess, requested.displayUrl, currentUrl, authenticated, redirectCount, options) };
		}
		if (cookieAccess.header !== undefined) {
			const confirmed = await confirmAuth(currentUrl, options);
			if (!confirmed) {
				return {
					status: "failed",
					details: withRequest(
						{
							status: "failed",
							error: {
								code: "AUTH_CONFIRMATION_REQUIRED",
								message: "authenticated request was not confirmed.",
							},
						},
						requested.displayUrl,
						currentUrl,
						false,
						redirectCount,
						options,
					),
				};
			}
			authenticated = true;
		}

		let response: WebHttpResponse;
		try {
			response = await fetchImpl(currentUrl, {
				method: "GET",
				redirect: "manual",
				dispatcher: options.dispatcher,
				signal: combinedSignal(options),
				headers: {
					"User-Agent": options.config.webfetch.user_agent,
					Accept: ACCEPT_HEADER,
					"Accept-Encoding": "gzip, deflate, br",
					...(cookieAccess.header !== undefined ? { Cookie: cookieAccess.header } : {}),
				},
			});
		} catch (error) {
			return { status: "failed", details: fetchErrorDetails(error, requested.displayUrl, currentUrl, authenticated, redirectCount, options) };
		}

		lastStatus = response.status;
		if (REDIRECT_STATUSES.has(response.status)) {
			await response.body?.cancel();
			const setCookieError = await options.cookieStore.storeFromResponse(currentUrl, setCookieHeaders(response.headers), allowlisted);
			if (setCookieError !== undefined) {
				return { status: "failed", details: withRequest(setCookieError, requested.displayUrl, currentUrl, authenticated, redirectCount, options) };
			}
			if (redirectCount >= options.config.webfetch.max_redirects) {
				return {
					status: "failed",
					details: withRequest(
						{ status: "failed", error: { code: "TOO_MANY_REDIRECTS", message: "redirect limit exceeded." } },
						requested.displayUrl,
						currentUrl,
						authenticated,
						redirectCount,
						options,
						response.status,
					),
				};
			}
			const location = response.headers.get("location");
			if (location === null) {
				return {
					status: "failed",
					details: withRequest(
						{ status: "failed", error: { code: "HTTP_ERROR", message: "redirect response has no Location header." } },
						requested.displayUrl,
						currentUrl,
						authenticated,
						redirectCount,
						options,
						response.status,
					),
				};
			}
			currentUrl = new URL(location, currentUrl);
			currentUrl.hash = "";
			redirectCount += 1;
			continue;
		}

		const expected = responseContentLength(response.headers);
		options.context.onUpdate?.({
			content: expected !== undefined ? `Downloading ${expected} bytes...` : "Downloading...",
			details: {
				status: "progress",
				phase: "downloading",
				http_status: response.status,
				...(expected !== undefined ? { expected_bytes: expected } : {}),
				redirect_count: redirectCount,
			},
		});
		let lastUpdate = 0;
		const body = await readLimitedResponseBody(response, {
			maxBytes: options.config.webfetch.limits.response_bytes,
			...(options.context.signal !== undefined ? { signal: options.context.signal } : {}),
			onProgress(receivedBytes) {
				const now = options.now();
				if (now - lastUpdate < 500) return;
				lastUpdate = now;
				options.context.onUpdate?.({
					content: `Downloading ${receivedBytes} bytes...`,
					details: {
						status: "progress",
						phase: "downloading",
						http_status: response.status,
						received_bytes: receivedBytes,
						...(expected !== undefined ? { expected_bytes: expected } : {}),
					},
				});
			},
		});
		if (body.status === "failed") {
			return {
				status: "failed",
				details: withRequest(
					{ status: "failed", error: { code: body.code, message: body.message } },
					requested.displayUrl,
					currentUrl,
					authenticated,
					redirectCount,
					options,
					response.status,
				),
			};
		}
		const setCookieError = await options.cookieStore.storeFromResponse(currentUrl, setCookieHeaders(response.headers), allowlisted);
		if (setCookieError !== undefined) {
			return { status: "failed", details: withRequest(setCookieError, requested.displayUrl, currentUrl, authenticated, redirectCount, options, response.status) };
		}
		if (response.status < 200 || response.status >= 300) {
			return {
				status: "failed",
				details: {
					...withRequest(
						{
							status: "failed",
							error: { code: "HTTP_ERROR", message: `${response.status} ${response.statusText || "HTTP error"}` },
						},
						requested.displayUrl,
						currentUrl,
						authenticated,
						redirectCount,
						options,
						response.status,
					),
					response_preview: previewText(body.bytes),
				},
			};
		}

		return {
			status: "success",
			requestedUrl: requested.displayUrl,
			finalUrl: redactUrl(currentUrl),
			httpStatus: response.status,
			statusText: response.statusText,
			headers: response.headers,
			body: body.bytes,
			authenticated,
			redirectCount,
			downloadedBytes: body.bytes.length,
		};
	}
}

async function confirmAuth(url: URL, options: HttpClientOptions): Promise<boolean> {
	const mode = options.config.webfetch.cookies.confirmation;
	const key = originKey(url);
	if (mode === "never" || (mode === "session" && options.approvedAuthOrigins.has(key))) return true;
	if (!options.context.hasUI || options.context.confirm === undefined) return false;
	const ok = await options.context.confirm("WebFetch authentication", `Send configured cookies to ${url.origin}?`);
	if (ok && mode === "session") options.approvedAuthOrigins.add(key);
	return ok;
}

function combinedSignal(options: HttpClientOptions): AbortSignal {
	return AbortSignal.any([options.context.signal ?? new AbortController().signal, AbortSignal.timeout(options.config.webfetch.timeout_seconds * 1000)]);
}

function fetchErrorDetails(
	error: unknown,
	requestedUrl: string,
	finalUrl: URL,
	authenticated: boolean,
	redirectCount: number,
	options: HttpClientOptions,
): WebFetchFailureDetails {
	const cause = errorCause(error);
	const message = [error instanceof Error ? error.message : String(error), cause?.message].filter(Boolean).join(": ");
	const code = classifyNetworkError(error, options.context.signal);
	return {
		status: "failed",
		error: { code, message },
		...(requestedUrl ? { requested_url: requestedUrl } : {}),
		final_url: safeRedact(finalUrl.toString()),
		authenticated,
		redirect_count: redirectCount,
		duration_ms: elapsed(options),
	};
}

export function classifyNetworkError(error: unknown, userSignal?: AbortSignal): "DNS_FAILED" | "CONNECTION_FAILED" | "TLS_FAILED" | "TIMEOUT" | "ABORTED" | "BLOCKED_ADDRESS" {
	const cause = errorCause(error);
	const message = [error instanceof Error ? error.message : String(error), cause?.message].filter(Boolean).join(": ");
	const codeText = `${cause?.code ?? ""} ${message}`.toLowerCase();
	if (userSignal?.aborted) return "ABORTED";
	if (codeText.includes("timeout") || error instanceof DOMException && error.name === "TimeoutError") return "TIMEOUT";
	if (codeText.includes("certificate") || codeText.includes("tls")) return "TLS_FAILED";
	if (codeText.includes("dns") || codeText.includes("enotfound")) return "DNS_FAILED";
	if (codeText.includes("blocked") || codeText.includes("eacces")) return "BLOCKED_ADDRESS";
	return "CONNECTION_FAILED";
}

function errorCause(error: unknown): { message?: string; code?: string } | undefined {
	if (typeof error !== "object" || error === null || !("cause" in error)) return undefined;
	const cause = error.cause;
	if (typeof cause !== "object" || cause === null) return undefined;
	return {
		...("message" in cause && typeof cause.message === "string" ? { message: cause.message } : {}),
		...("code" in cause && typeof cause.code === "string" ? { code: cause.code } : {}),
	};
}

function withRequest(
	details: WebFetchFailureDetails,
	requestedUrl: string,
	finalUrl: URL,
	authenticated: boolean,
	redirectCount: number,
	options: HttpClientOptions,
	httpStatus?: number,
): WebFetchFailureDetails {
	return {
		...details,
		requested_url: requestedUrl,
		final_url: safeRedact(finalUrl.toString()),
		...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
		authenticated,
		redirect_count: redirectCount,
		duration_ms: elapsed(options),
	};
}

function elapsed(options: HttpClientOptions): number {
	return options.now() - options.startedAt;
}

function setCookieHeaders(headers: WebHttpHeaders): string[] {
	const values = headers.getSetCookie?.();
	if (values !== undefined) return values;
	const single = headers.get("set-cookie");
	return single === null ? [] : [single];
}

function previewText(bytes: Uint8Array): string {
	const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\r\n?/g, "\n").trim();
	return text.slice(0, 500);
}

function safeRedact(value: string): string {
	try {
		return redactUrl(value);
	} catch {
		return value;
	}
}
