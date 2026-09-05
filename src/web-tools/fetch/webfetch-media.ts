import { fetchHttpUrl, type HttpClientOptions } from "../network/http-client.js";
import { mimeFromContentType, SUPPORTED_IMAGE_TYPES } from "../content/image-types.js";
import type {
	ContentConversion,
	HttpFetchSuccess,
	WebFetchFailureDetails,
	WebFetchMedia,
	WebFetchMode,
	WebFetchOmission,
} from "../core/types.js";

const IMAGE_ACCEPT = "image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1";

export interface PrimaryMediaResult {
	media?: WebFetchMedia;
	omission?: WebFetchOmission;
}

/** 识别直接图片响应，非图片候选交给普通内容转换器。 */
export async function directImageConversion(
	http: HttpFetchSuccess,
	mode: WebFetchMode,
	maxBytes: number,
	mediaEnabled: boolean,
): Promise<ContentConversion | WebFetchFailureDetails | undefined> {
	const declaredMime = mimeFromContentType(http.headers.get("content-type"));
	const declaredImage = declaredMime.startsWith("image/");
	if (mode !== "readable" || !(declaredMime === "" || declaredMime === "application/octet-stream" || declaredImage)) return undefined;
	if (http.bodyOmitted === "skipped_image_body") {
		return {
			text: `Image response [${declaredMime}]`,
			format: "image",
			analysis: {
				pageKind: "image",
				textSource: "metadata",
				omissions: [],
				deferredFragments: { discovered: 0, resolved: 0, limited: false },
				...(mediaEnabled ? { primaryMedia: { url: http.finalUrl } } : {}),
			},
			contentType: declaredMime,
		};
	}
	const mimeType = await detectImageMime(http.body);
	if (mimeType === undefined) {
		return declaredImage ? failure("UNSUPPORTED_CONTENT_TYPE", "response bytes are not a supported image.") : undefined;
	}
	if (http.body.byteLength > maxBytes) return failure("RESPONSE_TOO_LARGE", `image response exceeds ${maxBytes} bytes.`);
	return {
		text: `Image response [${mimeType}]`,
		format: "image",
		analysis: {
			pageKind: "image",
			textSource: "metadata",
			omissions: [],
			deferredFragments: { discovered: 0, resolved: 0, limited: false },
		},
		contentType: mimeType,
		...(mediaEnabled ? { directMedia: { data: http.body, mimeType } } : {}),
	};
}

/** 直接图片复用响应字节，HTML 主图通过同一安全 HTTP 链下载。 */
export async function resolvePrimaryMedia(
	conversion: ContentConversion,
	offset: number,
	options: HttpClientOptions,
): Promise<PrimaryMediaResult> {
	const primary = conversion.directMedia ?? conversion.analysis.primaryMedia;
	if (primary === undefined) return {};
	if (offset > 0) return { omission: { kind: "primary_media", reason: "offset_range" } };
	if (options.context.acceptsImages !== true) {
		return { omission: { kind: "primary_media", reason: options.context.imageOmissionReason ?? "model_no_image_input" } };
	}
	if ("data" in primary) return { media: primary };
	const fetched = await fetchHttpUrl(primary.url, options, { accept: IMAGE_ACCEPT, maxBytes: options.config.webfetch.media.response_bytes });
	if (fetched.status === "failed") {
		return {
			omission: {
				kind: "primary_media",
				reason: fetched.details.error.code === "RESPONSE_TOO_LARGE" ? "media_too_large" : "media_fetch_failed",
			},
		};
	}
	const mimeType = await detectImageMime(fetched.body);
	if (mimeType === undefined) return { omission: { kind: "primary_media", reason: "unsupported_media_type" } };
	return { media: { data: fetched.body, mimeType } };
}

async function detectImageMime(bytes: Uint8Array): Promise<string | undefined> {
	const { fileTypeFromBuffer } = await import("file-type");
	const detected = await fileTypeFromBuffer(bytes);
	return detected !== undefined && SUPPORTED_IMAGE_TYPES.has(detected.mime) ? detected.mime : undefined;
}

function failure(code: WebFetchFailureDetails["error"]["code"], message: string): WebFetchFailureDetails {
	return { status: "failed", error: { code, message } };
}
