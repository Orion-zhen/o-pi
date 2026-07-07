import type {
	ContentConversion,
	HttpFetchSuccess,
	SnapshotStatus,
	WebFetchFailureDetails,
	WebFetchParams,
	WebFetchResult,
	WebFetchSnapshot,
	WebToolsConfig,
	WebFetchExecutionContext,
	CookieStore,
} from "./types.js";
import { convertContent } from "./content-converter.js";
import { fetchHttpUrl, type HttpClientOptions } from "./http-client.js";
import { escapeXml, normalizeUrl, redactUrl } from "./url-utils.js";
import type { SnapshotCache } from "./snapshot-cache.js";

export interface ExecuteWebFetchRuntime extends Omit<HttpClientOptions, "config" | "context" | "startedAt"> {
	config: WebToolsConfig;
	context: WebFetchExecutionContext;
	snapshots: SnapshotCache;
	cookieStore: CookieStore;
}

export async function executeWebFetch(params: WebFetchParams, runtime: ExecuteWebFetchRuntime): Promise<WebFetchResult> {
	const startedAt = runtime.now();
	const validation = validateParams(params, runtime.config);
	if (validation !== undefined) return { content: failureContent(validation), details: { ...validation, duration_ms: runtime.now() - startedAt } };

	const mode = params.mode ?? "readable";
	const offset = params.offset ?? 0;
	const limit = params.limit ?? runtime.config.webfetch.limits.default_output_chars;
	const snapshotKey = snapshotKeyFor(params.url, mode);
	let snapshotStatus: SnapshotStatus = "not_needed";
	let conversion: ContentConversion | undefined;
	let http: HttpFetchSuccess | undefined;

	if (offset > 0) {
		const hit = runtime.snapshots.get(snapshotKey);
		if (hit !== undefined) {
			snapshotStatus = "hit";
			conversion = {
				text: hit.text,
				format: hit.metadata.format,
				...(hit.metadata.contentType ? { contentType: hit.metadata.contentType } : {}),
				...(hit.metadata.charset ? { charset: hit.metadata.charset } : {}),
				...(hit.metadata.title ? { title: hit.metadata.title } : {}),
			};
			http = snapshotToHttp(hit, params.url);
		} else {
			snapshotStatus = "refetched";
		}
	}

	if (conversion === undefined || http === undefined) {
		const fetched = await fetchHttpUrl(params.url, { ...runtime, startedAt });
		if (fetched.status === "failed") return { content: failureContent(fetched.details), details: fetched.details };
		runtime.context.onUpdate?.({ content: "Converting...", details: { status: "progress", phase: "converting", http_status: fetched.httpStatus } });
		const converted = convertContent(fetched.body, fetched.headers, fetched.finalUrl, mode);
		if ("status" in converted) {
			const details: WebFetchFailureDetails = {
				...converted,
				requested_url: fetched.requestedUrl,
				final_url: fetched.finalUrl,
				http_status: fetched.httpStatus,
				authenticated: fetched.authenticated,
				redirect_count: fetched.redirectCount,
				duration_ms: runtime.now() - startedAt,
			};
			return { content: failureContent(details), details };
		}
		http = fetched;
		conversion = converted;
	}

	const sliced = sliceText(conversion.text, offset, limit);
	if ("status" in sliced) {
		const details = {
			...sliced,
			requested_url: http.requestedUrl,
			final_url: http.finalUrl,
			http_status: http.httpStatus,
			authenticated: http.authenticated,
			redirect_count: http.redirectCount,
			duration_ms: runtime.now() - startedAt,
		};
		return { content: failureContent(details), details };
	}

	if (sliced.nextOffset !== undefined && snapshotStatus !== "hit") {
		snapshotStatus = "created";
		runtime.snapshots.set({
			key: snapshotKey,
			createdAt: runtime.now(),
			text: conversion.text,
			metadata: {
				finalUrl: http.finalUrl,
				httpStatus: http.httpStatus,
				...(conversion.contentType ? { contentType: conversion.contentType } : {}),
				...(conversion.charset ? { charset: conversion.charset } : {}),
				format: conversion.format,
				...(conversion.title ? { title: conversion.title } : {}),
				authenticated: http.authenticated,
				redirectCount: http.redirectCount,
				downloadedBytes: http.downloadedBytes,
			},
			sizeBytes: Buffer.byteLength(conversion.text, "utf8"),
		});
	}

	const details = {
		status: "success" as const,
		requested_url: http.requestedUrl,
		final_url: http.finalUrl,
		http_status: http.httpStatus,
		...(conversion.title ? { title: conversion.title } : {}),
		...(conversion.contentType ? { content_type: conversion.contentType } : {}),
		...(conversion.charset ? { charset: conversion.charset } : {}),
		format: conversion.format,
		downloaded_bytes: http.downloadedBytes,
		total_chars: conversion.text.length,
		range: {
			start: sliced.start,
			end: sliced.end,
			total: conversion.text.length,
			has_more: sliced.nextOffset !== undefined,
			...(sliced.nextOffset !== undefined ? { next_offset: sliced.nextOffset } : {}),
		},
		...(sliced.nextOffset !== undefined ? { next: `Call webfetch with the same url and mode, offset ${sliced.nextOffset}.` } : {}),
		authenticated: http.authenticated,
		redirect_count: http.redirectCount,
		snapshot: snapshotStatus,
		duration_ms: runtime.now() - startedAt,
		preview: preview(conversion.text),
	};
	return { content: successContent(details, sliced.text), details };
}

function validateParams(params: WebFetchParams, config: WebToolsConfig): WebFetchFailureDetails | undefined {
	if (typeof params.url !== "string" || params.url.length === 0) {
		return { status: "failed", error: { code: "INVALID_ARGUMENT", message: "url must be a non-empty string." } };
	}
	if (params.mode !== undefined && params.mode !== "readable" && params.mode !== "source") {
		return { status: "failed", error: { code: "INVALID_ARGUMENT", message: "mode must be readable or source." } };
	}
	if (params.offset !== undefined && (!Number.isInteger(params.offset) || params.offset < 0)) {
		return { status: "failed", error: { code: "INVALID_ARGUMENT", message: "offset must be a non-negative integer." } };
	}
	if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > config.webfetch.limits.max_output_chars)) {
		return { status: "failed", error: { code: "INVALID_ARGUMENT", message: `limit must be between 1 and ${config.webfetch.limits.max_output_chars}.` } };
	}
	return undefined;
}

function snapshotKeyFor(rawUrl: string, mode: string): string {
	let normalized = rawUrl;
	try {
		normalized = normalizeUrl(new URL(rawUrl));
	} catch {
		// 参数校验和 URL 校验会在后续返回结构化错误。
	}
	return `${mode}:${normalized}`;
}

function snapshotToHttp(snapshot: WebFetchSnapshot, requestedUrl: string): HttpFetchSuccess {
	return {
		status: "success",
		requestedUrl: safeRedact(requestedUrl),
		finalUrl: snapshot.metadata.finalUrl,
		httpStatus: snapshot.metadata.httpStatus,
		statusText: "",
		headers: new Headers(snapshot.metadata.contentType ? { "content-type": snapshot.metadata.contentType } : undefined),
		body: new Uint8Array(),
		authenticated: snapshot.metadata.authenticated,
		redirectCount: snapshot.metadata.redirectCount,
		downloadedBytes: snapshot.metadata.downloadedBytes,
	};
}

function sliceText(text: string, offset: number, limit: number): { text: string; start: number; end: number; nextOffset?: number } | WebFetchFailureDetails {
	if (offset > text.length || (offset === text.length && text.length > 0)) {
		return { status: "failed", error: { code: "OFFSET_OUT_OF_RANGE", message: "offset is beyond the result length." } };
	}
	const start = safeBoundary(text, offset);
	let end = safeBoundary(text, Math.min(text.length, start + limit));
	if (end < text.length) {
		const newline = text.lastIndexOf("\n", end);
		if (newline > start && end - newline < 1000) end = newline + 1;
		end = safeBoundary(text, end);
	}
	const sliced = text.slice(start, end);
	return {
		text: sliced,
		start,
		end,
		...(end < text.length ? { nextOffset: end } : {}),
	};
}

function safeBoundary(text: string, index: number): number {
	if (index <= 0 || index >= text.length) return Math.max(0, Math.min(index, text.length));
	const code = text.charCodeAt(index);
	return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}

function successContent(details: { requested_url: string; http_status: number; format: string; range: { start: number; end: number; total: number; has_more: boolean; next_offset?: number }; next?: string; authenticated: boolean }, text: string): string {
	const attrs = [
		`url="${escapeXml(details.requested_url)}"`,
		`status="${details.http_status}"`,
		`format="${escapeXml(details.format)}"`,
		`range="${details.range.start}-${details.range.end}/${details.range.total}"`,
		`has_more="${details.range.has_more ? "true" : "false"}"`,
		details.range.next_offset !== undefined ? `next_offset="${details.range.next_offset}"` : undefined,
		details.authenticated ? `auth="cookie"` : undefined,
		`trust="untrusted"`,
	]
		.filter((item): item is string => item !== undefined)
		.join(" ");
	const next = details.next !== undefined ? `\n<next>${escapeXml(details.next)}</next>` : "";
	return `<webfetch_result ${attrs}>\n${text}${next}\n</webfetch_result>`;
}

function failureContent(details: WebFetchFailureDetails): string {
	return `<error tool="webfetch" code="${escapeXml(details.error.code)}">
${escapeXml(details.error.message)}
</error>`;
}

function preview(text: string): string {
	return text.split("\n").slice(0, 12).join("\n").slice(0, 1200);
}

function safeRedact(value: string): string {
	try {
		return redactUrl(value);
	} catch {
		return value;
	}
}
