import { parseImageSrcset, type MediaCandidate } from "./html-page-analyzer.js";
import { fetchHttpUrl, type HttpClientOptions } from "./http-client.js";
import type {
	ContentConversion,
	HttpFetchSuccess,
	WebFetchFailureDetails,
	WebFetchMedia,
	WebFetchMode,
	WebFetchOmission,
} from "./types.js";

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const IMAGE_ACCEPT = "image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1";
const MIN_PRIMARY_SCORE = 2_800;

export interface PageMediaSelection {
	candidates: MediaCandidate[];
	primaryImage?: MediaCandidate;
}

export interface PrimaryMediaResult {
	media?: WebFetchMedia;
	omission?: WebFetchOmission;
}

/** Deduplicate all normalized media facts, then select at most one primary image. */
export function selectPageMedia(
	candidates: MediaCandidate[],
	selectedUrls: ReadonlySet<string>,
): PageMediaSelection {
	const deduplicated = deduplicateMediaCandidates(candidates);
	let best: { candidate: MediaCandidate; score: number } | undefined;
	for (const candidate of deduplicated) {
		if (candidate.kind !== "image") continue;
		const score = mediaScore(candidate, selectedUrls);
		if (score < MIN_PRIMARY_SCORE || (best !== undefined && score <= best.score)) continue;
		best = { candidate, score };
	}
	return {
		candidates: deduplicated,
		...(best !== undefined ? { primaryImage: best.candidate } : {}),
	};
}

/** Collect normalized image/poster URLs retained by the selected body candidate. */
export function selectedMediaUrls(html: string, document: Document, baseUrl: string): Set<string> {
	const root = document.createElement("div");
	root.innerHTML = html;
	const urls = new Set<string>();
	for (const image of root.querySelectorAll("img")) {
		addUrl(urls, image.getAttribute("src"), baseUrl);
		for (const item of parseImageSrcset(image.getAttribute("srcset"))) addUrl(urls, item.url, baseUrl);
	}
	for (const source of root.querySelectorAll("picture source")) {
		addUrl(urls, source.getAttribute("src"), baseUrl);
		for (const item of parseImageSrcset(source.getAttribute("srcset"))) addUrl(urls, item.url, baseUrl);
	}
	for (const video of root.querySelectorAll("video[poster]")) addUrl(urls, video.getAttribute("poster"), baseUrl);
	return urls;
}

/**
 * Recognize an already-downloaded direct image by bytes. Returns undefined when
 * the response is not an image candidate so the regular converter can decide.
 */
export async function directImageConversion(
	http: HttpFetchSuccess,
	mode: WebFetchMode,
	maxBytes: number,
): Promise<ContentConversion | WebFetchFailureDetails | undefined> {
	if (mode !== "readable" || !isDirectImageCandidate(http.headers.get("content-type"))) return undefined;
	const mimeType = await detectImageMime(http.body);
	if (mimeType === undefined) {
		if (isDeclaredImage(http.headers.get("content-type"))) {
			return failure("UNSUPPORTED_CONTENT_TYPE", "response bytes are not a supported image.");
		}
		return undefined;
	}
	if (http.body.byteLength > maxBytes) {
		return failure("RESPONSE_TOO_LARGE", `image response exceeds ${maxBytes} bytes.`);
	}
	return {
		text: `Image response [${mimeType}]`,
		format: "image",
		analysis: {
			pageKind: "image",
			textSource: "metadata",
			omissions: [],
			deferredFragments: { discovered: 0, resolved: 0 },
		},
		contentType: mimeType,
		directMedia: {
			data: http.body,
			mimeType,
			sourceUrl: http.finalUrl,
		},
	};
}

/** Resolve one direct or HTML-selected image through the shared secure HTTP path. */
export async function resolvePrimaryMedia(
	conversion: ContentConversion,
	offset: number,
	options: HttpClientOptions,
): Promise<PrimaryMediaResult> {
	const primary = conversion.directMedia
		?? (conversion.analysis.primaryMedia === undefined
			? undefined
			: { url: conversion.analysis.primaryMedia.url });
	if (primary === undefined) return {};
	if (options.config.webfetch.media.mode === "off") {
		return { omission: { kind: "primary_media", reason: "media_disabled" } };
	}
	if (offset > 0) return { omission: { kind: "primary_media", reason: "offset_range" } };
	if (options.context.acceptsImages !== true) {
		return {
			omission: {
				kind: "primary_media",
				reason: options.context.imageOmissionReason ?? "model_no_image_input",
			},
		};
	}
	if ("data" in primary) return { media: primary };
	const fetched = await fetchHttpUrl(
		primary.url,
		options,
		{ accept: IMAGE_ACCEPT, maxBytes: options.config.webfetch.media.response_bytes },
	);
	if (fetched.status === "failed") {
		return {
			omission: {
				kind: "primary_media",
				reason: fetched.details.error.code === "RESPONSE_TOO_LARGE" ? "media_too_large" : "media_fetch_failed",
			},
		};
	}
	const mimeType = await detectImageMime(fetched.body);
	if (mimeType === undefined) {
		return { omission: { kind: "primary_media", reason: "unsupported_media_type" } };
	}
	return {
		media: {
			data: fetched.body,
			mimeType,
			sourceUrl: fetched.finalUrl,
		},
	};
}

function deduplicateMediaCandidates(candidates: MediaCandidate[]): MediaCandidate[] {
	const deduplicated = new Map<string, MediaCandidate>();
	for (const candidate of candidates) {
		const url = candidate.secureUrl ?? candidate.url;
		const key = `${candidate.kind}\0${url}\0${candidate.width ?? ""}x${candidate.height ?? ""}`;
		const existing = deduplicated.get(key);
		if (existing === undefined) {
			deduplicated.set(key, { ...candidate });
			continue;
		}
		const preferred = intrinsicCandidateScore(candidate) > intrinsicCandidateScore(existing) ? candidate : existing;
		const mimeType = preferred.mimeType ?? existing.mimeType;
		const alt = preferred.alt ?? existing.alt;
		const titleDistance = minDefined(preferred.titleDistance, existing.titleDistance);
		deduplicated.set(key, {
			...preferred,
			...(mimeType !== undefined ? { mimeType } : {}),
			...(alt !== undefined ? { alt } : {}),
			presentation: preferred.presentation === true || existing.presentation === true,
			hidden: preferred.hidden === true || existing.hidden === true,
			likelyAvatar: preferred.likelyAvatar === true || existing.likelyAvatar === true,
			likelyDecorative: preferred.likelyDecorative === true || existing.likelyDecorative === true,
			...(titleDistance !== undefined ? { titleDistance } : {}),
		});
	}
	return [...deduplicated.values()];
}

function mediaScore(candidate: MediaCandidate, selectedUrls: ReadonlySet<string>): number {
	if (candidate.hidden === true || candidate.presentation === true) return Number.NEGATIVE_INFINITY;
	let score = intrinsicCandidateScore(candidate);
	if (selectedUrls.has(candidate.url) || (candidate.secureUrl !== undefined && selectedUrls.has(candidate.secureUrl))) score += 5_000;
	if (candidate.width !== undefined && candidate.height !== undefined) {
		score += Math.min(2_500, Math.sqrt(candidate.width * candidate.height) * 2);
		if (candidate.width <= 64 && candidate.height <= 64) score -= 8_000;
		else if (candidate.width <= 128 && candidate.height <= 128) score -= 2_000;
	} else if (candidate.width !== undefined) {
		score += Math.min(1_500, candidate.width);
	}
	score += Math.min(candidate.alt?.length ?? 0, 120) * 4;
	if (candidate.titleDistance !== undefined) score += Math.max(0, 1_200 - candidate.titleDistance * 120);
	if (candidate.likelyAvatar === true) score -= 10_000;
	if (candidate.likelyDecorative === true || looksLike(candidate, DECORATIVE_PATTERN)) score -= 9_000;
	return score;
}

function intrinsicCandidateScore(candidate: MediaCandidate): number {
	const role = {
		poster: 6_500,
		primary: 4_000,
		thumbnail: 3_500,
		content: 2_500,
		source: 1_000,
		embed: 0,
	}[candidate.role];
	const source = {
		open_graph: 1_500,
		json_ld: 1_300,
		twitter: 1_200,
		dom: 0,
		readability: 0,
		template: 0,
		noscript: 0,
	}[candidate.source];
	return role + source;
}

const DECORATIVE_PATTERN = /(?:^|[^a-z])(logo|icon|sprite|emoji|badge|decorative|decoration)(?:[^a-z]|$)/iu;

function looksLike(candidate: MediaCandidate, pattern: RegExp): boolean {
	return pattern.test(`${candidate.alt ?? ""} ${candidate.url}`);
}

function addUrl(output: Set<string>, value: string | null, baseUrl: string): void {
	if (value === null || value.trim().length === 0) return;
	try {
		const url = new URL(value, baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return;
		url.hash = "";
		output.add(url.toString());
	} catch {
		// Invalid candidates are ignored.
	}
}

function isDirectImageCandidate(contentType: string | null): boolean {
	const mime = mimeFromHeader(contentType);
	return mime === "" || mime === "application/octet-stream" || mime.startsWith("image/");
}

function isDeclaredImage(contentType: string | null): boolean {
	return mimeFromHeader(contentType).startsWith("image/");
}

function mimeFromHeader(contentType: string | null): string {
	return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function detectImageMime(bytes: Uint8Array): Promise<string | undefined> {
	const { fileTypeFromBuffer } = await import("file-type");
	const detected = await fileTypeFromBuffer(bytes);
	return detected !== undefined && SUPPORTED_IMAGE_TYPES.has(detected.mime) ? detected.mime : undefined;
}

function minDefined(left: number | undefined, right: number | undefined): number | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return Math.min(left, right);
}

function failure(code: WebFetchFailureDetails["error"]["code"], message: string): WebFetchFailureDetails {
	return { status: "failed", error: { code, message } };
}
