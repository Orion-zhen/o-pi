import type { PdfDocumentHandle } from "../../media/pdf-types.ts";
import { formatReadRanges, mergeReadRanges, parseReadRanges, type ResolvedReadRange } from "../../content-ranges.ts";
import type { WebFetchPdf } from "../content/types.ts";
import type { SnapshotStatus, WebFetchMedia, WebFetchParams, WebFetchRange, WebFetchResult, WebFetchSuccessDetails } from "../core/types.ts";
import type { HttpClientOptions } from "../network/http-client.ts";
import type { HttpFetchSuccess } from "../network/types.ts";
import { mimeFromContentType } from "../content/image-types.ts";
import type { SnapshotCache } from "./snapshot-cache.ts";
import { selectText } from "./text-selection.ts";
import { failureResult, preview, successContent } from "./webfetch-result.ts";

const MAX_IMAGE_PAGES = 20;
const MAX_TEXT_PAGES = 500;
const MAX_TEXT_CHARS = 5_000_000;

export function isPdfResponse(response: HttpFetchSuccess): boolean {
	return mimeFromContentType(response.headers.get("content-type")) === "application/pdf"
		|| Buffer.from(response.body.subarray(0, 5)).toString("ascii") === "%PDF-";
}

export async function executePdfFetch(
	params: WebFetchParams,
	resource: WebFetchPdf,
	options: HttpClientOptions,
	cache: SnapshotCache,
	cacheKey: string,
	snapshot: SnapshotStatus,
): Promise<WebFetchResult> {
	const response = resource.response;
	const failure = (code: "INVALID_ARGUMENT" | "UNSUPPORTED_CONTENT_TYPE" | "CONVERSION_FAILED" | "ABORTED" | "TIMEOUT", message: string) => failureResult({
		status: "failed", error: { code, message }, requested_url: response.requestedUrl, final_url: response.finalUrl,
		http_status: response.httpStatus, duration_ms: options.now() - options.startedAt,
	});
	if (params.mode === "source") return failure("UNSUPPORTED_CONTENT_TYPE", "PDF has no text source. Use readable or image mode.");
	const images = params.mode === "image";
	const deadline = AbortSignal.timeout(options.config.webfetch.timeout_seconds * 1000);
	const signal = options.context.signal === undefined ? deadline : AbortSignal.any([deadline, options.context.signal]);
	let document: PdfDocumentHandle | undefined;
	try {
		const { createPdfDocumentSource } = await import("../../media/pdf.ts");
		const opened = await createPdfDocumentSource().open({ bytes: resource.bytes, signal });
		if (!opened.ok) {
			signal.throwIfAborted();
			return failure("CONVERSION_FAILED", opened.message);
		}
		document = opened.value;
		signal.throwIfAborted();
		const ranges = selectPages(params.pages, document.pageCount);
		if (typeof ranges === "string") return failure("INVALID_ARGUMENT", ranges);
		const count = ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0);
		if (!images && count > MAX_TEXT_PAGES) return failure("INVALID_ARGUMENT", `PDF text selection exceeds ${MAX_TEXT_PAGES} pages. Set pages to a smaller range.`);
		const numbers: number[] = [];
		const remaining: ResolvedReadRange[] = [];
		for (const range of ranges) {
			for (let number = range.start; number <= range.end; number += 1) {
				if (images && numbers.length === MAX_IMAGE_PAGES) {
					remaining.push({ start: number, end: range.end });
					break;
				}
				numbers.push(number);
			}
		}
		const textPages = new Map(resource.textPages);
		const media: WebFetchMedia[] = [];
		const spans: Array<{ number: number; start: number; end: number }> = [];
		const chunks: string[] = [];
		let length = 0;
		let emptyPages = false;
		for (const number of numbers) {
			signal.throwIfAborted();
			if (images) {
				const rendered = await document.renderPage({ pageNumber: number, signal });
				signal.throwIfAborted();
				if (!rendered.ok) return failure("CONVERSION_FAILED", rendered.message);
				const { resizeImage } = await import("@earendil-works/pi-coding-agent");
				const resized = await resizeImage(Buffer.from(rendered.value.bytes), rendered.value.mimeType);
				signal.throwIfAborted();
				if (resized === null) return failure("CONVERSION_FAILED", `PDF page ${number} exceeds the inline image size limit.`);
				media.push({ page: number, data: Buffer.from(resized.data, "base64"), mimeType: resized.mimeType });
			} else {
				const text = textPages.get(number) ?? await document.readPageText({ pageNumber: number, signal });
				textPages.set(number, text);
				emptyPages ||= text.length === 0;
				const chunk = `${text}\n\n`;
				spans.push({ number, start: length, end: length + chunk.length });
				chunks.push(chunk);
				length += chunk.length;
				if (length > MAX_TEXT_CHARS) return failure("CONVERSION_FAILED", "PDF extracted text exceeds the size limit. Set pages to a smaller range.");
			}
		}
		const text = chunks.join("");
		const selected = selectText(text, params.offset ?? 0, Math.max(options.config.webfetch.limits.default_output_chars, params.find?.length ?? 0),
			params.find === undefined ? undefined : { text: params.find, maxPassages: options.config.webfetch.limits.find_max_passages });
		const body = images ? "" : pageText(text, selected.range, spans);
		const note = emptyPages ? '\nPages without extractable text are not searched. Use mode="image" to inspect them.' : "";
		signal.throwIfAborted();
		const stored = cache.setPdf(cacheKey, { ...resource, textPages });
		const details: WebFetchSuccessDetails = {
			status: "success", scope: "static_response", page_kind: "pdf", text_source: images ? "metadata" : "pdf",
			completeness: images ? "complete" : "partial",
			omissions: images ? [] : [{ kind: "pdf_content", reason: emptyPages ? "no_text_layer" : "pdf_text_only" }],
			requested_url: response.requestedUrl, final_url: response.finalUrl, http_status: response.httpStatus,
			...(document.metadata.title ? { title: document.metadata.title } : {}),
			content_type: "application/pdf", format: images ? "image" : "text",
			pdf: { total_pages: document.pageCount, pages: formatReadRanges(mergeReadRanges(numbers.map((number) => ({ start: number, end: number })))),
				...(remaining.length > 0 ? { next_pages: formatReadRanges(remaining) } : {}) },
			downloaded_bytes: response.downloadedBytes, total_chars: text.length, range: selected.range,
			authenticated: response.authenticated, redirect_count: response.redirectCount,
			snapshot: snapshot === "hit" ? "hit" : stored ? "created" : snapshot,
			deferred_fragments: { discovered: 0, resolved: 0, limited: false },
			media: { discovered: images ? count : 0, returned: media.length },
			duration_ms: options.now() - options.startedAt, preview: preview(body + note),
		};
		return { content: successContent(details, body + note), details, ...(images ? { media } : {}) };
	} catch (error) {
		if (signal.aborted) return failure(options.context.signal?.aborted ? "ABORTED" : "TIMEOUT", "PDF processing was aborted.");
		return failure("CONVERSION_FAILED", error instanceof Error ? error.message : String(error));
	} finally {
		try { await document?.dispose(); } catch { /* 清理失败不能覆盖读取结果。 */ }
	}
}

function selectPages(value: string | undefined, total: number): ResolvedReadRange[] | string {
	if (value === undefined) return [{ start: 1, end: total }];
	const parsed = parseReadRanges(value, "pages");
	if (!parsed.ok) return parsed.message;
	for (const range of parsed.value) {
		if (range.start > total) return `pages start ${range.start} is outside 1-${total}.`;
	}
	return mergeReadRanges(parsed.value.map((range) => ({ start: range.start, end: Math.min(range.end ?? total, total) })));
}

function pageText(text: string, range: WebFetchRange, pages: Array<{ number: number; start: number; end: number }>): string {
	const passages = range.kind === "find" ? range.passages : [{ start: range.start, end: range.end }];
	return passages.map((passage) => {
		const parts = pages.filter((page) => page.start < passage.end && page.end > passage.start).map((page) => {
			const start = Math.max(passage.start, page.start);
			const end = Math.min(passage.end, page.end);
			return `[page ${page.number}]\n${text.slice(start, end)}`;
		});
		return `${range.kind === "find" ? `[${passage.start}-${passage.end}]\n` : ""}${parts.join("\n")}`;
	}).join("\n\n");
}
