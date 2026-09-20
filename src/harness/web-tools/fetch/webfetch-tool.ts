import type {
	SnapshotStatus,
	WebFetchFailureDetails,
	WebFetchMode,
	WebFetchOmission,
	WebFetchParams,
	WebFetchResult,
	WebFetchSuccessDetails,
} from "../core/types.ts";
import type { ContentConversion, WebFetchPage, WebFetchPdf } from "../content/types.ts";
import { fetchHttpUrl, type HttpClientOptions } from "../network/http-client.ts";
import { validateRequestUrl } from "../network/network-policy.ts";
import type { ValidatedUrl } from "../network/types.ts";
import { redactUrl } from "../network/url-utils.ts";
import { directImageConversion, resolvePrimaryMedia } from "./webfetch-media.ts";
import { selectText } from "./text-selection.ts";
import type { SnapshotCache } from "./snapshot-cache.ts";

import { executePdfFetch, isPdfResponse } from "./webfetch-pdf.ts";
import { failureResult, preview, successContent } from "./webfetch-result.ts";

export interface ExecuteWebFetchRuntime extends Omit<HttpClientOptions, "startedAt"> {
	snapshots: SnapshotCache;
}

export async function executeWebFetch(params: WebFetchParams, runtime: ExecuteWebFetchRuntime): Promise<WebFetchResult> {
	const options: HttpClientOptions = { ...runtime, startedAt: runtime.now() };
	const mode = params.mode ?? "readable";
	const offset = params.offset ?? 0;
	const limit = Math.max(runtime.config.webfetch.limits.default_output_chars, params.find?.length ?? 0);
	const textOnly = params.find !== undefined;
	if (runtime.context.signal?.aborted) return failureResult({ status: "failed", error: { code: "ABORTED", message: "webfetch was aborted." } });
	if (mode === "image" && (params.find !== undefined || params.offset !== undefined)) {
		return failureResult({ status: "failed", error: { code: "INVALID_ARGUMENT", message: "image mode does not accept find or offset." } });
	}
	const requested = validateRequestUrl(params.url, runtime.context.privateNetworkGrant?.origin);
	if ("status" in requested) {
		return failureResult({ ...requested, requested_url: safeRedact(params.url), duration_ms: runtime.now() - options.startedAt });
	}
	const mediaPolicy = runtime.config.webfetch.media.mode;
	const mediaEnabled = mediaPolicy === "on" || mediaPolicy === "auto" && mode === "image";
	if (mode === "image" && !mediaEnabled) {
		return failureResult({ status: "failed", error: { code: "INVALID_ARGUMENT", message: "Image output is disabled by webfetch.media.mode." } });
	}
	if (mode === "image" && runtime.context.acceptsImages !== true) {
		return failureResult({ status: "failed", error: { code: "UNSUPPORTED_CONTENT_TYPE", message: "Current model does not support images. Use readable mode for text." } });
	}
	const textMode = mode === "source" ? "source" : "readable";
	const canReturnImages = !textOnly && textMode === "readable" && offset === 0 && mediaEnabled && runtime.context.acceptsImages === true;
	const snapshotKey = snapshotKeyFor(requested, textMode, mediaEnabled, runtime.context.privateNetworkGrant?.origin);
	const pdfKey = `pdf\0${snapshotKeyFor(requested, "readable", false, runtime.context.privateNetworkGrant?.origin)}`;
	const useSnapshot = params.offset !== undefined || textOnly || params.pages !== undefined || mode === "image";
	const cached = useSnapshot ? runtime.snapshots.get(snapshotKey) ?? runtime.snapshots.getPdf(pdfKey) : undefined;
	let snapshotStatus: SnapshotStatus = !useSnapshot ? "not_needed" : cached === undefined ? "refetched" : "hit";
	const page = cached ?? await readPage(requested, textMode, mediaEnabled, canReturnImages, options);
	if ("status" in page) return failureResult(page);
	if ("bytes" in page) return executePdfFetch(params, page, options, runtime.snapshots, pdfKey, snapshotStatus);
	if (params.pages !== undefined) {
		return failureResult({ status: "failed", error: { code: "INVALID_ARGUMENT", message: "pages requires a PDF response." } });
	}
	if (textOnly && page.format === "image") {
		return failureResult({
			status: "failed", error: { code: "UNSUPPORTED_CONTENT_TYPE", message: "find requires text content, not an image response." },
			requested_url: page.response.requestedUrl, final_url: page.response.finalUrl, http_status: page.response.httpStatus,
		});
	}

	const selected = selectText(mode === "image" ? "" : page.text, offset, limit, params.find === undefined
		? undefined
		: { text: params.find, maxPassages: runtime.config.webfetch.limits.find_max_passages });
	if (snapshotStatus !== "hit" && page.format !== "image") {
		const stored = runtime.snapshots.set(snapshotKey, page);
		if (stored && offset === 0) snapshotStatus = "created";
	}

	const mediaResult = !textOnly && mediaEnabled ? await resolvePrimaryMedia(page, offset, options) : {};
	if (mode === "image" && mediaResult.media === undefined) {
		return failureResult({ status: "failed", error: {
			code: mediaResult.omission === undefined ? "UNSUPPORTED_CONTENT_TYPE" : "CONVERSION_FAILED",
			message: mediaResult.omission === undefined ? "No primary image found. Use readable mode for text." : `Image not returned: ${mediaResult.omission.reason}.`,
		}, requested_url: page.response.requestedUrl, final_url: page.response.finalUrl, http_status: page.response.httpStatus });
	}
	const omissions = mode === "image" ? [] : collectOmissions(page, mediaResult.omission, !textOnly);
	if (
		!textOnly
		&& page.analysis.pageKind === "image"
		&& offset === 0
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
		text_source: mode === "image" ? "metadata" : page.analysis.textSource,
		completeness: omissions.length === 0 ? "complete" : "partial",
		omissions,
		requested_url: response.requestedUrl,
		final_url: response.finalUrl,
		http_status: response.httpStatus,
		...(page.title ? { title: page.title } : {}),
		...(page.anchor !== undefined ? { anchor: page.anchor } : {}),
		...(page.contentType ? { content_type: page.contentType } : {}),
		...(page.charset ? { charset: page.charset } : {}),
		format: mode === "image" ? "image" : page.format,
		downloaded_bytes: response.downloadedBytes,
		total_chars: selected.range.total,
		range: selected.range,
		authenticated: response.authenticated,
		redirect_count: response.redirectCount,
		snapshot: snapshotStatus,
		deferred_fragments: page.analysis.deferredFragments,
		media: {
			discovered: page.directMedia !== undefined || page.analysis.primaryMedia !== undefined ? 1 : 0,
			returned: mediaResult.media !== undefined ? 1 : 0,
		},
		duration_ms: runtime.now() - options.startedAt,
		preview: preview(textOnly || mode === "image" ? selected.text : page.text),
	};
	return {
		content: successContent(details, selected.text),
		details,
		...(mediaResult.media !== undefined ? { media: [mediaResult.media] } : {}),
	};
}

async function readPage(
	requested: ValidatedUrl,
	mode: Exclude<WebFetchMode, "image">,
	mediaEnabled: boolean,
	canReturnImages: boolean,
	options: HttpClientOptions,
): Promise<WebFetchPage | WebFetchPdf | WebFetchFailureDetails> {
	const converterPromise = import("../content/content-converter.ts");
	const fetched = await fetchHttpUrl(requested, options, {
		imageMaxBytes: options.config.webfetch.media.response_bytes,
		preferHtmlForFragment: mode === "readable",
		omitSupportedImageBody: !canReturnImages,
	});
	if (fetched.status === "failed") {
		void converterPromise.catch(() => undefined);
		return fetched.details;
	}
	options.context.onUpdate?.({ content: "Converting...", details: { status: "progress", phase: "converting", http_status: fetched.httpStatus } });
	const response = {
		requestedUrl: fetched.requestedUrl, finalUrl: fetched.finalUrl, httpStatus: fetched.httpStatus,
		authenticated: fetched.authenticated, redirectCount: fetched.redirectCount, downloadedBytes: fetched.downloadedBytes,
	};
	if (isPdfResponse(fetched)) {
		void converterPromise.catch(() => undefined);
		if (fetched.fragment !== "" && mode !== "source") return {
			status: "failed", error: { code: "ANCHOR_NOT_FOUND", message: "PDF selection uses pages, not URL fragments. Remove the fragment and set pages." },
			requested_url: fetched.requestedUrl, final_url: fetched.finalUrl, http_status: fetched.httpStatus,
		};
		return { bytes: fetched.body, textPages: new Map(), response };
	}
	const direct = mode === "readable" && fetched.fragment !== ""
		? undefined
		: await directImageConversion(fetched, mode, options.config.webfetch.media.response_bytes, mediaEnabled);
	if (direct !== undefined) void converterPromise.catch(() => undefined);
	const converted = direct ?? await (await converterPromise).convertContent(
		fetched.body,
		fetched.headers,
		`${fetched.finalUrl}${fetched.fragment}`,
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
	return { ...converted, response };
}

function collectOmissions(
	conversion: ContentConversion,
	mediaOmission: WebFetchOmission | undefined,
	includePrimaryMedia: boolean,
): WebFetchOmission[] {
	const omissions: WebFetchOmission[] = [];
	const deferred = conversion.analysis.deferredFragments;
	if (deferred.resolved < deferred.discovered) omissions.push({ kind: "deferred_content", reason: "unresolved_declaration" });
	omissions.push(...conversion.analysis.omissions);
	if (mediaOmission !== undefined) omissions.push(mediaOmission);
	const pageKind = conversion.analysis.pageKind;
	if (includePrimaryMedia && pageKind === "video") omissions.push({ kind: "primary_media", reason: "video_not_returned" });
	if (includePrimaryMedia && pageKind === "audio") omissions.push({ kind: "primary_media", reason: "audio_not_returned" });
	return omissions;
}

function snapshotKeyFor(requested: ValidatedUrl, mode: Exclude<WebFetchMode, "image">, mediaEnabled: boolean, privateNetworkOrigin: string | undefined): string {
	const normalized = `${requested.url}${mode === "source" ? "" : requested.fragment}`;
	return `${privateNetworkOrigin ?? "public"}\0${mode}:${mediaEnabled ? "media" : "no-media"}:${normalized}`;
}

function safeRedact(value: string): string {
	try { return redactUrl(value); } catch { return value; }
}
