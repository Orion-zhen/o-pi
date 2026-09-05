import type {
	ContentConversion,
	SnapshotStatus,
	WebFetchFailureDetails,
	WebFetchMode,
	WebFetchOmission,
	WebFetchPage,
	WebFetchParams,
	WebFetchResult,
	WebFetchSuccessDetails,
} from "../core/types.js";
import { fetchHttpUrl, type HttpClientOptions } from "../network/http-client.js";
import { escapeXml } from "../network/url-utils.js";
import { directImageConversion, resolvePrimaryMedia } from "./webfetch-media.js";
import type { SnapshotCache } from "./snapshot-cache.js";

const PREVIEW_MAX_LINES = 40;
const PREVIEW_MAX_CHARS = 6000;

export interface ExecuteWebFetchRuntime extends Omit<HttpClientOptions, "startedAt"> {
	snapshots: SnapshotCache;
}

export async function executeWebFetch(params: WebFetchParams, runtime: ExecuteWebFetchRuntime): Promise<WebFetchResult> {
	const options: HttpClientOptions = { ...runtime, startedAt: runtime.now() };
	const mode = params.mode ?? "readable";
	const offset = params.offset ?? 0;
	const limit = params.limit ?? runtime.config.webfetch.limits.default_output_chars;
	const mediaEnabled = runtime.config.webfetch.media.mode === "auto";
	const canReturnImages = mode === "readable" && offset === 0 && mediaEnabled && runtime.context.acceptsImages === true;
	const snapshotKey = snapshotKeyFor(params.url, mode, mediaEnabled, runtime.context.privateNetworkGrant?.origin);
	const cached = offset > 0 ? runtime.snapshots.get(snapshotKey) : undefined;
	let snapshotStatus: SnapshotStatus = offset === 0 ? "not_needed" : cached === undefined ? "refetched" : "hit";
	const page = cached ?? await readPage(params.url, mode, canReturnImages, options);
	if ("status" in page) return { content: failureContent(page), details: page };

	const sliced = sliceText(page.text, offset, limit);
	if (sliced.nextOffset !== undefined && snapshotStatus !== "hit" && page.directMedia === undefined) {
		snapshotStatus = "created";
		runtime.snapshots.set(snapshotKey, page);
	}

	const mediaResult = mediaEnabled ? await resolvePrimaryMedia(page, offset, options) : {};
	const omissions = collectOmissions(page, sliced.start, sliced.nextOffset, mediaResult.omission);
	if (
		page.analysis.pageKind === "image"
		&& mediaEnabled
		&& mediaResult.media === undefined
		&& !omissions.some((item) => item.kind === "primary_media")
	) {
		omissions.push({ kind: "primary_media", reason: "media_fetch_failed" });
	}
	const response = page.response;
	const details: WebFetchSuccessDetails = {
		status: "success",
		scope: "static_response",
		page_kind: page.analysis.pageKind,
		text_source: page.analysis.textSource,
		completeness: omissions.length === 0 ? "complete" : "partial",
		omissions,
		requested_url: response.requestedUrl,
		final_url: response.finalUrl,
		http_status: response.httpStatus,
		...(page.title ? { title: page.title } : {}),
		...(page.contentType ? { content_type: page.contentType } : {}),
		...(page.charset ? { charset: page.charset } : {}),
		format: page.format,
		downloaded_bytes: response.downloadedBytes,
		total_chars: page.text.length,
		range: {
			start: sliced.start,
			end: sliced.end,
			total: page.text.length,
			has_more: sliced.nextOffset !== undefined,
			...(sliced.nextOffset !== undefined ? { next_offset: sliced.nextOffset } : {}),
		},
		authenticated: response.authenticated,
		redirect_count: response.redirectCount,
		snapshot: snapshotStatus,
		deferred_fragments: page.analysis.deferredFragments,
		media: {
			discovered: page.directMedia !== undefined || page.analysis.primaryMedia !== undefined ? 1 : 0,
			returned: mediaResult.media !== undefined ? 1 : 0,
		},
		duration_ms: runtime.now() - options.startedAt,
		preview: preview(page.text),
	};
	return {
		content: successContent(details, sliced.text),
		details,
		...(mediaResult.media !== undefined ? { media: [mediaResult.media] } : {}),
	};
}

async function readPage(
	rawUrl: string,
	mode: WebFetchMode,
	canReturnImages: boolean,
	options: HttpClientOptions,
): Promise<WebFetchPage | WebFetchFailureDetails> {
	const mediaEnabled = options.config.webfetch.media.mode === "auto";
	const converterPromise = import("../content/content-converter.js");
	const fetched = await fetchHttpUrl(rawUrl, options, {
		imageMaxBytes: options.config.webfetch.media.response_bytes,
		omitSupportedImageBody: !canReturnImages,
	});
	if (fetched.status === "failed") {
		void converterPromise.catch(() => undefined);
		return fetched.details;
	}
	options.context.onUpdate?.({ content: "Converting...", details: { status: "progress", phase: "converting", http_status: fetched.httpStatus } });
	const direct = await directImageConversion(fetched, mode, options.config.webfetch.media.response_bytes, mediaEnabled);
	if (direct !== undefined) void converterPromise.catch(() => undefined);
	const converted = direct ?? await (await converterPromise).convertContent(
		fetched.body,
		fetched.headers,
		fetched.finalUrl,
		mode,
		{ charThreshold: options.config.webfetch.readability.char_threshold },
		mediaEnabled,
	);
	if ("status" in converted) {
		return {
			...converted,
			requested_url: fetched.requestedUrl,
			final_url: fetched.finalUrl,
			http_status: fetched.httpStatus,
			authenticated: fetched.authenticated,
			redirect_count: fetched.redirectCount,
			duration_ms: options.now() - options.startedAt,
		};
	}
	return {
		...converted,
		response: {
			requestedUrl: fetched.requestedUrl,
			finalUrl: fetched.finalUrl,
			httpStatus: fetched.httpStatus,
			authenticated: fetched.authenticated,
			redirectCount: fetched.redirectCount,
			downloadedBytes: fetched.downloadedBytes,
		},
	};
}

function collectOmissions(
	conversion: ContentConversion,
	start: number,
	nextOffset: number | undefined,
	mediaOmission: WebFetchOmission | undefined,
): WebFetchOmission[] {
	const omissions: WebFetchOmission[] = [];
	if (start > 0 || nextOffset !== undefined) omissions.push({ kind: "text_range", reason: "range" });
	const deferred = conversion.analysis.deferredFragments;
	if (deferred.resolved < deferred.discovered) omissions.push({ kind: "deferred_content", reason: "unresolved_declaration" });
	omissions.push(...conversion.analysis.omissions);
	if (mediaOmission !== undefined) omissions.push(mediaOmission);
	const pageKind = conversion.analysis.pageKind;
	if (pageKind === "video") omissions.push({ kind: "primary_media", reason: "video_not_returned" });
	if (pageKind === "audio") omissions.push({ kind: "primary_media", reason: "audio_not_returned" });
	return omissions;
}

function snapshotKeyFor(rawUrl: string, mode: WebFetchMode, mediaEnabled: boolean, privateNetworkOrigin: string | undefined): string {
	let normalized = rawUrl;
	try {
		const url = new URL(rawUrl);
		url.hash = "";
		normalized = url.toString();
	} catch {
		// 无效 URL 会在 HTTP 请求边界返回结构化错误。
	}
	return `${privateNetworkOrigin ?? "public"}\0${mode}:${mediaEnabled ? "media" : "no-media"}:${normalized}`;
}

function sliceText(text: string, offset: number, limit: number): { text: string; start: number; end: number; nextOffset?: number } {
	const start = safeBoundary(text, Math.min(text.length, offset));
	let end = safeBoundary(text, Math.min(text.length, start + limit));
	if (end < text.length) {
		const newline = text.lastIndexOf("\n", end);
		if (newline > start && end - newline < 1000) end = newline + 1;
		end = safeBoundary(text, end);
	}
	return { text: text.slice(start, end), start, end, ...(end < text.length ? { nextOffset: end } : {}) };
}

function safeBoundary(text: string, index: number): number {
	if (index <= 0 || index >= text.length) return Math.max(0, Math.min(index, text.length));
	const code = text.charCodeAt(index);
	return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}

function successContent(details: WebFetchSuccessDetails, text: string): string {
	const partialReasons = [...new Set(details.omissions.map((item) => item.reason))];
	const attrs = [
		`kind="${details.page_kind}"`,
		details.final_url !== details.requested_url ? `final="${escapeXml(details.final_url)}"` : undefined,
		details.text_source === "metadata" ? `source="metadata"` : undefined,
		partialReasons.length > 0 ? `partial="${partialReasons.join(",")}"` : undefined,
		details.range.next_offset !== undefined ? `next="${details.range.next_offset}"` : undefined,
	].filter((item): item is string => item !== undefined).join(" ");
	return `<webfetch ${attrs}>\n${text}\n</webfetch>`;
}

function failureContent(details: WebFetchFailureDetails): string {
	return `<error tool="webfetch" code="${escapeXml(details.error.code)}">\n${escapeXml(details.error.message)}\n</error>`;
}

function preview(text: string): string {
	return text.split("\n").slice(0, PREVIEW_MAX_LINES).join("\n").slice(0, PREVIEW_MAX_CHARS);
}
