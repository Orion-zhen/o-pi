import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { parse as parseContentTypeHeader } from "content-type";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

import type { ContentConversion, WebFetchMode, WebFetchOutputFormat, WebFetchFailureDetails, WebHttpHeaders } from "./types.js";

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/javascript", "application/x-javascript"]);
const JSON_TYPES = new Set(["application/json", "application/ld+json"]);
const XML_TYPES = new Set(["application/xml", "text/xml", "application/rss+xml", "application/atom+xml"]);
const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	fence: "```",
	bulletListMarker: "-",
	emDelimiter: "*",
	strongDelimiter: "**",
	linkStyle: "inlined",
	preformattedCode: true,
});
turndown.use(gfm);

export function convertContent(
	body: Uint8Array,
	headers: WebHttpHeaders,
	finalUrl: string,
	mode: WebFetchMode,
): ContentConversion | WebFetchFailureDetails {
	const contentTypeHeader = headers.get("content-type") ?? "text/plain";
	const parsedContentType = parseContentType(contentTypeHeader);
	if ("status" in parsedContentType) return parsedContentType;
	const { mime, charset } = parsedContentType;
	const kind = classifyMime(mime);
	if (kind === "binary") {
		return failure("UNSUPPORTED_CONTENT_TYPE", `${mime || "binary content"} is not supported.`);
	}
	if (hasBinaryNul(body)) {
		return failure("UNSUPPORTED_CONTENT_TYPE", "binary content is not supported.");
	}

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
	if (kind === "html") return htmlToMarkdown(normalized, finalUrl, mime, decoded.charset);
	return {
		text: normalized,
		format: kind,
		...(mime ? { contentType: mime } : {}),
		...(decoded.charset ? { charset: decoded.charset } : {}),
	};
}

function htmlToMarkdown(html: string, finalUrl: string, mime: string, charset?: string): ContentConversion | WebFetchFailureDetails {
	try {
		const { document } = parseHTML(html);
		removeUnsafeOrNoisyNodes(document);
		absolutizeUrls(document.body, finalUrl);
		const fallbackTitle = document.querySelector("title")?.textContent?.trim() || undefined;
		const readable = new Readability(document.cloneNode(true) as Document, { charThreshold: 0 }).parse();
		const readableHtml = readable?.content?.trim();
		const rootHtml = readableHtml && readableHtml.length > 0 ? readableHtml : document.body.innerHTML;
		const converted = normalizeMarkdown(turndown.turndown(rootHtml)).trim();
		const title = readable?.title?.trim() || fallbackTitle;
		return {
			text: converted,
			format: "markdown",
			contentType: mime,
			...(charset ? { charset } : {}),
			...(title ? { title } : {}),
		};
	} catch (error) {
		return failure("CONVERSION_FAILED", error instanceof Error ? error.message : String(error));
	}
}

function normalizeMarkdown(value: string): string {
	return normalizeLineEndings(value)
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
}

/** 在 Readability 前删除不会进入模型的脚本、控件和隐藏节点，降低正文抽取噪声。 */
function removeUnsafeOrNoisyNodes(document: Document): void {
	for (const selector of [
		"script",
		"style",
		"noscript",
		"template",
		"svg",
		"canvas",
		"iframe",
		"object",
		"embed",
		"form",
		"input",
		"select",
		"textarea",
		"button",
		"header",
		"nav",
		"footer",
		"[hidden]",
		'[aria-hidden="true"]',
	]) {
		document.querySelectorAll(selector).forEach((node) => node.remove());
	}
}

function absolutizeUrls(root: Element, finalUrl: string): void {
	for (const node of root.querySelectorAll("a[href]")) {
		const href = node.getAttribute("href");
		const safe = safeAbsoluteUrl(href, finalUrl);
		if (safe === undefined) node.removeAttribute("href");
		else node.setAttribute("href", safe);
	}
	for (const node of root.querySelectorAll("img[src]")) {
		const src = node.getAttribute("src");
		const safe = safeAbsoluteUrl(src, finalUrl);
		if (safe === undefined) node.remove();
		else node.setAttribute("src", safe);
	}
}

function safeAbsoluteUrl(value: string | null, base: string): string | undefined {
	if (value === null || value.trim() === "") return undefined;
	try {
		const url = new URL(value, base);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
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

function decodeBytes(body: Uint8Array, charset?: string): { text: string; charset: string } | WebFetchFailureDetails {
	const normalized = (charset ?? "utf-8").toLowerCase();
	const label = normalized === "utf8" ? "utf-8" : normalized;
	try {
		let bytes = body;
		if (label === "utf-8" && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
			bytes = body.slice(3);
		}
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
	const sample = body.subarray(0, Math.min(body.length, 4096));
	return sample.includes(0);
}

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

function failure(code: WebFetchFailureDetails["error"]["code"], message: string): WebFetchFailureDetails {
	return { status: "failed", error: { code, message } };
}
