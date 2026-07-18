import { parse as parseContentTypeHeader } from "content-type";

import type { ContentConversion, WebFetchFailureDetails, WebFetchMode, WebFetchOutputFormat, WebHttpHeaders } from "./types.js";

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/javascript", "application/x-javascript"]);
const JSON_TYPES = new Set(["application/json", "application/ld+json"]);
const XML_TYPES = new Set(["application/xml", "text/xml", "application/rss+xml", "application/atom+xml"]);

export interface HtmlContentConverter {
	htmlToMarkdown(html: string, finalUrl: string, mime: string, charset?: string): ContentConversion | WebFetchFailureDetails;
}

export type HtmlContentConverterLoader = () => Promise<HtmlContentConverter>;

const loadHtmlContentConverter: HtmlContentConverterLoader = () => import("./html-content-converter.js");

/** Decode lightweight text directly; load the DOM/Readability/Turndown graph only for readable HTML. */
export async function convertContent(
	body: Uint8Array,
	headers: WebHttpHeaders,
	finalUrl: string,
	mode: WebFetchMode,
	loadHtml: HtmlContentConverterLoader = loadHtmlContentConverter,
): Promise<ContentConversion | WebFetchFailureDetails> {
	const contentTypeHeader = headers.get("content-type") ?? "text/plain";
	const parsedContentType = parseContentType(contentTypeHeader);
	if ("status" in parsedContentType) return parsedContentType;
	const { mime, charset } = parsedContentType;
	const kind = shouldTreatUrlAsHtml(finalUrl, mode) ? "html" : classifyMime(mime);
	if (kind === "binary") return failure("UNSUPPORTED_CONTENT_TYPE", `${mime || "binary content"} is not supported.`);
	if (hasBinaryNul(body)) return failure("UNSUPPORTED_CONTENT_TYPE", "binary content is not supported.");

	const decoded = decodeBytes(body, charset);
	if ("status" in decoded) return decoded;
	const normalized = normalizeLineEndings(decoded.text);
	if (mode === "source") {
		return {
			text: normalized,
			format: "source",
			...(mime ? { contentType: mime } : {}),
			...(decoded.charset ? { charset: decoded.charset } : {}),
		};
	}
	if (kind === "html") {
		try {
			return (await loadHtml()).htmlToMarkdown(normalized, finalUrl, mime, decoded.charset);
		} catch (error) {
			return failure("CONVERSION_FAILED", error instanceof Error ? error.message : String(error));
		}
	}
	return {
		text: normalized,
		format: kind,
		...(mime ? { contentType: mime } : {}),
		...(decoded.charset ? { charset: decoded.charset } : {}),
	};
}

function parseContentType(header: string): { mime: string; charset?: string } | WebFetchFailureDetails {
	try {
		const parsed = parseContentTypeHeader(header);
		const charset = parsed.parameters["charset"]?.toLowerCase();
		return {
			mime: parsed.type.toLowerCase(),
			...(charset ? { charset } : {}),
		};
	} catch {
		return failure("UNSUPPORTED_CONTENT_TYPE", "Content-Type header is invalid.");
	}
}

function classifyMime(mime: string): WebFetchOutputFormat | "html" | "binary" {
	if (mime === "" || mime === "application/octet-stream") return "binary";
	if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
	if (JSON_TYPES.has(mime) || mime.endsWith("+json")) return "json";
	if (XML_TYPES.has(mime) || mime.endsWith("+xml")) return "xml";
	if (TEXT_TYPES.has(mime) || mime.startsWith("text/")) return "text";
	return "binary";
}

/** Some sites serve static HTML as text/plain or octet-stream. */
function shouldTreatUrlAsHtml(finalUrl: string, mode: WebFetchMode): boolean {
	if (mode !== "readable") return false;
	try {
		const pathname = new URL(finalUrl).pathname.toLowerCase();
		return pathname.endsWith(".html") || pathname.endsWith(".htm");
	} catch {
		return false;
	}
}

function decodeBytes(body: Uint8Array, charset?: string): { text: string; charset: string } | WebFetchFailureDetails {
	const normalized = (charset ?? "utf-8").toLowerCase();
	const label = normalized === "utf8" ? "utf-8" : normalized;
	try {
		let bytes = body;
		if (label === "utf-8" && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) bytes = body.slice(3);
		return { text: new TextDecoder(label, { fatal: false }).decode(bytes), charset: label };
	} catch {
		try {
			return { text: new TextDecoder("utf-8", { fatal: false }).decode(body), charset: "utf-8" };
		} catch {
			return failure("DECODE_FAILED", "response text cannot be decoded.");
		}
	}
}

function hasBinaryNul(body: Uint8Array): boolean {
	return body.subarray(0, Math.min(body.length, 4096)).includes(0);
}

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

function failure(code: WebFetchFailureDetails["error"]["code"], message: string): WebFetchFailureDetails {
	return { status: "failed", error: { code, message } };
}
