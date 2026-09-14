import type {
	SnapshotStatus,
	WebFetchFailureDetails,
	WebFetchMode,
	WebFetchOmission,
	WebFetchParams,
	WebFetchResult,
	WebFetchSuccessDetails,
} from "../core/types.ts";
import type { ContentConversion, WebFetchPage } from "../content/types.ts";
import { fetchHttpUrl, type HttpClientOptions } from "../network/http-client.ts";
import { validateRequestUrl } from "../network/network-policy.ts";
import type { ValidatedUrl } from "../network/types.ts";
import { escapeXml, redactUrl } from "../network/url-utils.ts";
import { directImageConversion, resolvePrimaryMedia } from "./webfetch-media.ts";
import { selectText } from "./text-selection.ts";
import type { SnapshotCache } from "./snapshot-cache.ts";

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
	const textOnly = params.find !== undefined;
	if (runtime.context.signal?.aborted) return failureResult({ status: "failed", error: { code: "ABORTED", message: "webfetch was aborted." } });
	if (params.find !== undefined && limit < params.find.length) {
		return failureResult({ status: "failed", error: { code: "INVALID_ARGUMENT", message: "limit must fit the full find string." } });
	}
	const requested = validateRequestUrl(params.url, runtime.context.privateNetworkGrant?.origin);
	if ("status" in requested) {
		return failureResult({ ...requested, requested_url: safeRedact(params.url), duration_ms: runtime.now() - options.startedAt });
	}
	const mediaEnabled = runtime.config.webfetch.media.mode === "auto";
	const canReturnImages = !textOnly && mode === "readable" && offset === 0 && mediaEnabled && runtime.context.acceptsImages === true;
	const snapshotKey = snapshotKeyFor(requested, mode, mediaEnabled, runtime.context.privateNetworkGrant?.origin);
	const useSnapshot = params.offset !== undefined || textOnly;
	const cached = useSnapshot ? runtime.snapshots.get(snapshotKey) : undefined;
	let snapshotStatus: SnapshotStatus = !useSnapshot ? "not_needed" : cached === undefined ? "refetched" : "hit";
	const page = cached ?? await readPage(requested, mode, canReturnImages, options);
	if ("status" in page) return failureResult(page);
	if (textOnly && page.format === "image") {
		return failureResult({
			status: "failed", error: { code: "UNSUPPORTED_CONTENT_TYPE", message: "find requires text content, not an image response." },
			requested_url: page.response.requestedUrl, final_url: page.response.finalUrl, http_status: page.response.httpStatus,
		});
	}

	const selected = selectText(page.text, offset, limit, params.find === undefined
		? undefined
		: { text: params.find, maxPassages: runtime.config.webfetch.limits.find_max_passages });
	if (snapshotStatus !== "hit" && page.format !== "image") {
		const stored = runtime.snapshots.set(snapshotKey, page);
		if (stored && offset === 0) snapshotStatus = "created";
	}

	const mediaResult = !textOnly && mediaEnabled ? await resolvePrimaryMedia(page, offset, options) : {};
	const omissions = collectOmissions(page, mediaResult.omission, !textOnly);
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
		text_source: page.analysis.textSource,
		completeness: omissions.length === 0 ? "complete" : "partial",
		omissions,
		requested_url: response.requestedUrl,
		final_url: response.finalUrl,
		http_status: response.httpStatus,
		...(page.title ? { title: page.title } : {}),
		...(page.anchor !== undefined ? { anchor: page.anchor } : {}),
		...(page.contentType ? { content_type: page.contentType } : {}),
		...(page.charset ? { charset: page.charset } : {}),
		format: page.format,
		downloaded_bytes: response.downloadedBytes,
		total_chars: page.text.length,
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
		preview: preview(textOnly ? selected.text : page.text),
	};
	return {
		content: successContent(details, selected.text),
		details,
		...(mediaResult.media !== undefined ? { media: [mediaResult.media] } : {}),
	};
}

async function readPage(
	requested: ValidatedUrl,
	mode: WebFetchMode,
	canReturnImages: boolean,
	options: HttpClientOptions,
): Promise<WebFetchPage | WebFetchFailureDetails> {
	const mediaEnabled = options.config.webfetch.media.mode === "auto";
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

function snapshotKeyFor(requested: ValidatedUrl, mode: WebFetchMode, mediaEnabled: boolean, privateNetworkOrigin: string | undefined): string {
	const normalized = `${requested.url}${mode === "source" ? "" : requested.fragment}`;
	return `${privateNetworkOrigin ?? "public"}\0${mode}:${mediaEnabled ? "media" : "no-media"}:${normalized}`;
}

function safeRedact(value: string): string {
	try { return redactUrl(value); } catch { return value; }
}

function successContent(details: WebFetchSuccessDetails, text: string): string {
	const partialReasons = [...new Set(details.omissions.map((item) => item.reason))];
	const attrs = [
		`kind="${details.page_kind}"`,
		details.range.kind === "find" ? `matches="${details.range.matches}"` : undefined,
		details.anchor !== undefined ? `anchor="${escapeXml(details.anchor)}"` : undefined,
		details.final_url !== details.requested_url ? `final="${escapeXml(details.final_url)}"` : undefined,
		details.text_source === "metadata" ? `source="metadata"` : undefined,
		partialReasons.length > 0 ? `partial="${partialReasons.join(",")}"` : undefined,
		details.range.next_offset !== undefined ? `next="${details.range.next_offset}"` : undefined,
	].filter((item): item is string => item !== undefined).join(" ");
	return `<webfetch ${attrs}>\n${text}\n</webfetch>`;
}

function failureResult(details: WebFetchFailureDetails): WebFetchResult {
	return { content: `<error tool="webfetch" code="${escapeXml(details.error.code)}">\n${escapeXml(details.error.message)}\n</error>`, details };
}

function preview(text: string): string {
	return text.split("\n").slice(0, PREVIEW_MAX_LINES).join("\n").slice(0, PREVIEW_MAX_CHARS);
}
