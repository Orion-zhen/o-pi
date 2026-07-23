import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

import { removeHtmlOutputNoise, selectHtmlContent } from "./html-content-selector.js";
import { extractDeferredContent } from "./html-deferred-content.js";
import { analyzeHtmlPage, type PageAnalysis, type TextCandidate } from "./html-page-analyzer.js";
import type { ContentConversion, HtmlReadabilityOptions, WebFetchFailureDetails, WebFetchTextSource } from "./types.js";
import { selectedMediaUrls, selectPageMedia } from "./webfetch-media.js";

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
export function htmlToMarkdown(
	html: string,
	finalUrl: string,
	mime: string,
	options: HtmlReadabilityOptions,
	charset?: string,
): ContentConversion | WebFetchFailureDetails {
	try {
		const { document } = parseHTML(html);
		const analysis = analyzeHtmlPage(document, finalUrl, mime);
		const baseDocument = document.cloneNode(true) as Document;
		const deferred = extractDeferredContent(document, baseDocument);
		analysis.deferred = deferred.evidence;
		const deferredFragments = {
			discovered: deferred.evidence.discovered,
			resolved: deferred.evidence.resolved,
		};
		const selected = selectDocumentBody(baseDocument, finalUrl, options, analysis);
		const title = analysis.metadata.heading?.value ?? selected.title ?? analysis.metadata.title?.value;
		const deferredSections = deferred.fragments
			.map((fragment) => fragmentToMarkdown(fragment, document, finalUrl))
			.filter((fragment) => fragment.length > 0);
		const text = composeSections(title, selected, analysis, deferredSections);
		const pageMedia = selectPageMedia(analysis.mediaCandidates, selected.mediaUrls);
		analysis.mediaCandidates = pageMedia.candidates;
		const primaryMediaUrl = pageMedia.primaryImage === undefined
			? undefined
			: pageMedia.primaryImage.secureUrl ?? pageMedia.primaryImage.url;
		const mediaDominant = primaryMediaUrl !== undefined
			&& (
				analysis.pageKind === "video"
				|| analysis.pageKind === "audio"
				|| selected.textLength < 160
			);
		return {
			text,
			format: "markdown",
			analysis: {
				pageKind: analysis.pageKind,
				textSource: selected.source,
				omissions: analysis.omissions,
				deferredFragments,
				...(primaryMediaUrl !== undefined ? { primaryMedia: { url: primaryMediaUrl } } : {}),
			},
			contentType: mime,
			...(charset ? { charset } : {}),
			...(title ? { title } : {}),
			extraction: {
				analysis,
				textSource: selected.source,
				deferredFragments,
				...(primaryMediaUrl !== undefined ? { primaryMedia: { url: primaryMediaUrl } } : {}),
				mediaDominant,
			},
		};
	} catch (error) {
		return { status: "failed", error: { code: "CONVERSION_FAILED", message: error instanceof Error ? error.message : String(error) } };
	}
}

interface SelectedBody {
	text: string;
	source: WebFetchTextSource;
	textLength: number;
	blockCount: number;
	title?: string;
	structured?: TextCandidate;
	mediaUrls: Set<string>;
}

function selectDocumentBody(
	document: Document,
	finalUrl: string,
	options: HtmlReadabilityOptions,
	analysis: PageAnalysis,
): SelectedBody {
	removeUnsafeNodes(document);
	absolutizeUrls(document.documentElement, finalUrl);
	const selection = selectHtmlContent(document, options, analysis.metadata.heading?.value);
	if (selection.preferred !== undefined) {
		return {
			text: markdownFromHtml(selection.preferred.html),
			source: selection.preferred.source,
			textLength: selection.preferred.textLength,
			blockCount: selection.preferred.blockCount,
			mediaUrls: selectedMediaUrls(selection.preferred.html, document, finalUrl),
			...(selection.preferred.title !== undefined ? { title: selection.preferred.title } : {}),
		};
	}
	const structured = analysis.textCandidates.find((candidate) => candidate.kind === "article_body")
		?? analysis.textCandidates.find((candidate) => candidate.kind === "transcript");
	if (structured !== undefined) {
		return {
			text: structured.text,
			source: "metadata",
			textLength: structured.text.length,
			blockCount: 1,
			structured,
			mediaUrls: new Set<string>(),
		};
	}
	const hasMetadataFallback = analysis.metadata.title !== undefined || analysis.metadata.description !== undefined;
	if (selection.bodyPassesQuality || !hasMetadataFallback) {
		return {
			text: markdownFromHtml(selection.body.html),
			source: "body",
			textLength: selection.body.textLength,
			blockCount: selection.body.blockCount,
			mediaUrls: selectedMediaUrls(selection.body.html, document, finalUrl),
			...(selection.body.title !== undefined ? { title: selection.body.title } : {}),
		};
	}
	return { text: "", source: "metadata", textLength: 0, blockCount: 0, mediaUrls: new Set<string>() };
}

interface OutputSection {
	text: string;
	comparable: string;
}

function composeSections(
	title: string | undefined,
	selected: SelectedBody,
	analysis: PageAnalysis,
	deferred: string[],
): string {
	const sections: OutputSection[] = [];
	const metadataLines: string[] = [];
	if (title !== undefined) metadataLines.push(`# ${title}`);
	if (analysis.metadata.authors.length > 0) {
		metadataLines.push(`**Author:** ${analysis.metadata.authors.map((author) => author.value).join(", ")}`);
	}
	if (analysis.metadata.publishedAt !== undefined) metadataLines.push(`**Published:** ${analysis.metadata.publishedAt.value}`);
	if (analysis.metadata.modifiedAt !== undefined) metadataLines.push(`**Modified:** ${analysis.metadata.modifiedAt.value}`);
	appendSection(sections, metadataLines.join("\n\n"));

	const main = removeMatchingTitleHeading(selected.text, title);
	appendSection(sections, main);

	const hasSubstantiveMain = selected.structured?.kind === "article_body"
		|| selected.structured === undefined && (selected.blockCount > 0 || comparableText(main).length >= 40);
	const description = analysis.metadata.description?.value;
	if (!hasSubstantiveMain && description !== undefined) appendSection(sections, description);

	for (const candidate of analysis.textCandidates) {
		if (candidate === selected.structured) continue;
		appendSection(
			sections,
			candidate.text,
			candidate.kind === "transcript" ? "Transcript" : "Structured content",
		);
	}

	const deferredSections: OutputSection[] = [];
	for (const fragment of deferred) appendSection(deferredSections, fragment, undefined, sections);
	if (deferredSections.length > 0) {
		const combined = deferredSections.map((section) => section.text).join("\n\n");
		appendSection(sections, combined, "Deferred content");
	}
	return normalizeMarkdown(sections.map((section) => section.text).join("\n\n")).trim();
}

function appendSection(
	sections: OutputSection[],
	rawText: string,
	heading?: string,
	additionalExisting: OutputSection[] = [],
): void {
	const text = normalizeMarkdown(rawText).trim();
	const comparable = comparableSectionText(text);
	if (comparable.length === 0) return;
	const existing = [...additionalExisting, ...sections];
	if (existing.some((section) =>
		section.comparable === comparable
		|| section.comparable.includes(comparable)
		|| comparable.includes(section.comparable)
	)) {
		return;
	}
	sections.push({
		text: heading === undefined ? text : `## ${heading}\n\n${text}`,
		comparable,
	});
}

function removeMatchingTitleHeading(text: string, title: string | undefined): string {
	const comparableTitle = comparableText(title ?? "");
	if (comparableTitle.length === 0) return text;
	const lines = text.split("\n");
	const index = lines.findIndex((line, lineIndex) => {
		if (lineIndex > 4) return false;
		const match = /^#{1,6}\s+(.+)$/u.exec(line.trim());
		return match !== null && comparableText(match[1] ?? "") === comparableTitle;
	});
	if (index >= 0) lines.splice(index, 1);
	return normalizeMarkdown(lines.join("\n")).trim();
}

function markdownFromHtml(html: string): string {
	return normalizeMarkdown(turndown.turndown(html)).trim();
}

function fragmentToMarkdown(html: string, document: Document, finalUrl: string): string {
	const root = document.createElement("div");
	root.innerHTML = html;
	removeUnsafeNodes(root);
	removeHtmlOutputNoise(root);
	absolutizeUrls(root, finalUrl);
	return markdownFromHtml(root.innerHTML);
}

function positiveDimension(value: string | null): number | undefined {
	if (value === null || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeMarkdown(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
}

function comparableText(value: string | null | undefined): string {
	return (value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function comparableSectionText(value: string): string {
	return comparableText(
		value
			.replace(/!\[([^\]]*)\]\(([^)]+)\)/gu, "image $1 $2")
			.replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
			.replace(/^#{1,6}\s+/gmu, "")
			.replace(/^\s*[-+]\s+/gmu, "")
			.replace(/[*_`>|]/gu, ""),
	);
}

function removeUnsafeNodes(root: Document | Element): void {
	for (const selector of [
		"script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed",
		"[hidden]", '[aria-hidden="true"]',
	]) {
		root.querySelectorAll(selector).forEach((node) => node.remove());
	}
	for (const image of root.querySelectorAll("img")) {
		const width = positiveDimension(image.getAttribute("width"));
		const height = positiveDimension(image.getAttribute("height"));
		if (width !== undefined && height !== undefined && width <= 2 && height <= 2) image.remove();
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
