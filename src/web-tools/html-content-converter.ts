import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

import type { ContentConversion, WebFetchFailureDetails } from "./types.js";

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

/** Heavy readable-HTML path, imported only after a response is classified as HTML. */
export function htmlToMarkdown(html: string, finalUrl: string, mime: string, charset?: string): ContentConversion | WebFetchFailureDetails {
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
		return { status: "failed", error: { code: "CONVERSION_FAILED", message: error instanceof Error ? error.message : String(error) } };
	}
}

function normalizeMarkdown(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
}

function removeUnsafeOrNoisyNodes(document: Document): void {
	for (const selector of [
		"script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "form",
		"input", "select", "textarea", "button", "header", "nav", "footer", "[hidden]", '[aria-hidden="true"]',
	]) {
		document.querySelectorAll(selector).forEach((node) => node.remove());
	}
}

function absolutizeUrls(root: Element, finalUrl: string): void {
	for (const node of root.querySelectorAll("a[href]")) {
		const safe = safeAbsoluteUrl(node.getAttribute("href"), finalUrl);
		if (safe === undefined) node.removeAttribute("href");
		else node.setAttribute("href", safe);
	}
	for (const node of root.querySelectorAll("img[src]")) {
		const safe = safeAbsoluteUrl(node.getAttribute("src"), finalUrl);
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
