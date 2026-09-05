import type { Dispatcher } from "undici";

import type {
	CookieAccess,
	CookieStore,
	HttpFetchResult,
	HttpFetchSuccess,
	WebFetchExecutionContext,
	WebToolsConfig,
	WebFetchFailureDetails,
	WebHttpFetch,
	WebHttpResponse,
} from "../core/types.js";
import { mimeFromContentType, supportedImageMimeFromHeader } from "../content/image-types.js";
import { classifyNetworkError, networkErrorMessage } from "./errors.js";
import { validateRequestUrl } from "./network-policy.js";
import { cancelBody, readLimitedResponseBody, responseContentLength } from "./response-body.js";
import { matchesDomainRule, redactUrl } from "./url-utils.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ACCEPT_HEADER = "text/markdown, text/plain;q=0.9, application/json;q=0.9, application/xml;q=0.8, text/html;q=0.8, */*;q=0.1";

export interface HttpClientOptions {
	dispatcher: Dispatcher;
	privateNetworkDispatcher?: Dispatcher;
	fetchImpl: WebHttpFetch;
	cookieStore: CookieStore;
	approvedAuthOrigins: Set<string>;
	config: WebToolsConfig;
	context: WebFetchExecutionContext;
	startedAt: number;
	now: () => number;
}

export interface HttpResourceOptions {
	accept?: string;
	maxBytes?: number;
	imageMaxBytes?: number;
	omitSupportedImageBody?: boolean;
}

export async function fetchHttpUrl(rawUrl: string, options: HttpClientOptions, resource: HttpResourceOptions = {}): Promise<HttpFetchResult> {
	const deadline = createDeadline(options.config.webfetch.timeout_seconds * 1000);
	const requestSignal = options.context.signal === undefined ? deadline.signal : AbortSignal.any([options.context.signal, deadline.signal]);
	try {
		return await fetchWithinDeadline(rawUrl, options, resource, requestSignal);
	} finally {
		deadline.dispose();
	}
}

async function fetchWithinDeadline(
	rawUrl: string,
	options: HttpClientOptions,
	resource: HttpResourceOptions,
	signal: AbortSignal,
): Promise<HttpFetchResult> {
	const requested = validateRequestUrl(rawUrl, options.context.privateNetworkGrant?.origin);
	if ("status" in requested) {
		return { status: "failed", details: { ...requested, requested_url: safeRedact(rawUrl), duration_ms: options.now() - options.startedAt } };
	}
	const requestedUrl = requested.displayUrl;
	let currentUrl = requested.url;
	let redirectCount = 0;
	let authenticated = false;
	let lastStatus: number | undefined;

	function failure(details: WebFetchFailureDetails, httpStatus?: number): Extract<HttpFetchResult, { status: "failed" }> {
		return {
			status: "failed",
			details: {
				...details,
				requested_url: requestedUrl,
				final_url: redactUrl(currentUrl),
				...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
				authenticated,
				redirect_count: redirectCount,
				duration_ms: options.now() - options.startedAt,
			},
		};
	}

	function networkFailure(error: unknown): HttpFetchResult {
		const code = signal.aborted ? abortCode(signal, options.context.signal) : classifyNetworkError(error, options.context.signal);
		return failure({ status: "failed", error: { code, message: networkErrorMessage(error) } });
	}

	function success(response: WebHttpResponse, body: Uint8Array, omitted?: HttpFetchSuccess["bodyOmitted"]): HttpFetchSuccess {
		return {
			status: "success",
			requestedUrl,
			finalUrl: redactUrl(currentUrl),
			httpStatus: response.status,
			headers: response.headers,
			body,
			...(omitted !== undefined ? { bodyOmitted: omitted } : {}),
			authenticated,
			redirectCount,
			downloadedBytes: body.byteLength,
		};
	}

	try {
		while (true) {
			if (redirectCount > 0) {
				const checked = validateRequestUrl(currentUrl.toString(), options.context.privateNetworkGrant?.origin);
				if ("status" in checked) return failure(checked, lastStatus);
				currentUrl = checked.url;
			}
			options.context.onUpdate?.({
				content: redirectCount > 0 ? "Redirecting..." : "Requesting...",
				details: { status: "progress", phase: redirectCount > 0 ? "redirecting" : "requesting", redirect_count: redirectCount },
			});

			const allowlisted = options.config.webfetch.cookies.enabled
				&& matchesDomainRule(currentUrl.hostname, options.config.webfetch.cookies.domains);
			const cookieAccess: CookieAccess | WebFetchFailureDetails = allowlisted
				? await waitForAbort(options.cookieStore.getCookieAccess(currentUrl), signal)
				: {};
			if ("status" in cookieAccess) return failure(cookieAccess);
			if (cookieAccess.header !== undefined) {
				if (!await waitForAbort(confirmAuth(currentUrl, options), signal)) {
					const result = failure({ status: "failed", error: { code: "AUTH_CONFIRMATION_REQUIRED", message: "authenticated request was not confirmed." } });
					result.details.authenticated = false;
					return result;
				}
				authenticated = true;
			}

			let response: WebHttpResponse;
			try {
				response = await waitForAbort(options.fetchImpl(currentUrl, {
					method: "GET",
					redirect: "manual",
					dispatcher: dispatcherFor(currentUrl, options),
					signal,
					headers: {
						"User-Agent": options.config.webfetch.user_agent,
						Accept: resource.accept ?? ACCEPT_HEADER,
						"Accept-Encoding": "gzip, deflate, br",
						...(cookieAccess.header !== undefined ? { Cookie: cookieAccess.header } : {}),
					},
				}), signal);
			} catch (error) {
				return networkFailure(error);
			}
			lastStatus = response.status;
			const saveCookies = () => allowlisted
				? waitForAbort(options.cookieStore.storeFromResponse(currentUrl, response.headers.getSetCookie()), signal)
				: Promise.resolve(undefined);

			if (REDIRECT_STATUSES.has(response.status)) {
				cancelBody(response.body);
				const cookieError = await saveCookies();
				if (cookieError !== undefined) return failure(cookieError);
				if (redirectCount >= options.config.webfetch.max_redirects) {
					return failure({ status: "failed", error: { code: "TOO_MANY_REDIRECTS", message: "redirect limit exceeded." } }, response.status);
				}
				const location = response.headers.get("location");
				if (location === null) return failure({ status: "failed", error: { code: "HTTP_ERROR", message: "redirect response has no Location header." } }, response.status);
				currentUrl = new URL(location, currentUrl);
				currentUrl.hash = "";
				redirectCount += 1;
				continue;
			}

			if (
				resource.omitSupportedImageBody === true
				&& response.status >= 200 && response.status < 300
				&& supportedImageMimeFromHeader(response.headers.get("content-type")) !== undefined
			) {
				cancelBody(response.body);
				const cookieError = await saveCookies();
				if (cookieError !== undefined) return failure(cookieError, response.status);
				return success(response, new Uint8Array(), "skipped_image_body");
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
			const imageResponse = mimeFromContentType(response.headers.get("content-type")).startsWith("image/");
			const maxBytes = resource.maxBytes ?? (imageResponse ? resource.imageMaxBytes : undefined) ?? options.config.webfetch.limits.response_bytes;
			let lastUpdate = 0;
			const body = await readLimitedResponseBody(response, {
				maxBytes,
				signal,
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
				const code = body.code === "ABORTED" ? abortCode(signal, options.context.signal) : body.code;
				return failure({ status: "failed", error: { code, message: body.message } }, response.status);
			}
			// 普通响应仍在正文读取成功后更新 Cookie，超限或下载失败不更新。
			const cookieError = await saveCookies();
			if (cookieError !== undefined) return failure(cookieError, response.status);
			if (response.status < 200 || response.status >= 300) {
				return failure({
					status: "failed",
					error: { code: "HTTP_ERROR", message: `${response.status} ${response.statusText || "HTTP error"}` },
					response_preview: previewText(body.bytes),
				}, response.status);
			}
			return success(response, body.bytes);
		}
	} catch (error) {
		// Cookie 存储与交互端口本身不接受 signal，只在取消时转换等待错误。
		if (signal.aborted) return networkFailure(error);
		throw error;
	}
}

function dispatcherFor(url: URL, options: HttpClientOptions): Dispatcher {
	return options.privateNetworkDispatcher !== undefined && options.context.privateNetworkGrant?.origin === url.origin
		? options.privateNetworkDispatcher : options.dispatcher;
}

async function confirmAuth(url: URL, options: HttpClientOptions): Promise<boolean> {
	const mode = options.config.webfetch.cookies.confirmation;
	if (mode === "never" || (mode === "session" && options.approvedAuthOrigins.has(url.origin))) return true;
	if (options.context.interaction === undefined) return false;
	const ok = await options.context.interaction.confirmAuthentication("WebFetch authentication", `Send configured cookies to ${url.origin}?`);
	if (ok && mode === "session") options.approvedAuthOrigins.add(url.origin);
	return ok;
}

function createDeadline(durationMs: number): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new DOMException("webfetch deadline exceeded.", "TimeoutError")), Math.max(0, durationMs));
	return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => { cleanup(); resolve(value); },
			(error: unknown) => { cleanup(); reject(error); },
		);
	});
}

function abortCode(signal: AbortSignal, userSignal: AbortSignal | undefined): "TIMEOUT" | "ABORTED" {
	return userSignal?.aborted === true ? "ABORTED" : signal.aborted ? "TIMEOUT" : "ABORTED";
}

function previewText(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\r\n?/g, "\n").trim().slice(0, 500);
}

function safeRedact(value: string): string {
	try { return redactUrl(value); } catch { return value; }
}
