import { isProbablyReaderable, Readability } from "@mozilla/readability";

import type { HtmlReadabilityOptions } from "./types.js";

export type HtmlTextSource = "readability" | "semantic" | "heading" | "body";

export interface SelectedHtmlContent {
	source: HtmlTextSource;
	html: string;
	title?: string;
	textLength: number;
	blockCount: number;
}

export interface HtmlContentSelection {
	preferred?: SelectedHtmlContent;
	body: SelectedHtmlContent;
	bodyPassesQuality: boolean;
}

interface ContentQuality {
	textLength: number;
	linkDensity: number;
	shortLinkListRatio: number;
	headingCount: number;
	paragraphCount: number;
	codeCount: number;
	tableCount: number;
	mediaCount: number;
	formCount: number;
	noiseRatio: number;
	hasPrimaryTitle: boolean;
}

interface Candidate {
	source: HtmlTextSource;
	root: Element;
	quality: ContentQuality;
	title?: string;
}

const SEMANTIC_SELECTOR = 'main, [role="main"], article, [itemprop="articleBody"]';
const OUTPUT_NOISE_SELECTORS = [
	"header",
	"nav",
	"footer",
	"aside",
	"form",
	"input",
	"select",
	"textarea",
	"button",
	'[role="navigation"]',
	'[role="complementary"]',
	'[role="button"]',
	'[role="menu"]',
	'[role="menuitem"]',
	'[role="listbox"]',
	'[role="option"]',
	'[role="combobox"]',
	'[role="search"]',
	'[role="toolbar"]',
	'[role="tablist"]',
	"[aria-haspopup]",
	"[placeholder]",
	'[contenteditable="true"]',
	'[slot="tooltip-content"]',
	'[slot="dropdown-items"]',
	'[slot="selected-item"]',
	'[slot*="sort"]',
	'[class*="recommend"]',
	'[id*="recommend"]',
	'[class*="related"]',
	'[id*="related"]',
	'[class*="sidebar"]',
	'[id*="sidebar"]',
	'[class*="trending"]',
	'[id*="trending"]',
] as const;

/** Generate ordered HTML candidates and select Readability/semantic/heading before exposing body fallback. */
export function selectHtmlContent(
	document: Document,
	options: HtmlReadabilityOptions,
	primaryTitle?: string,
): HtmlContentSelection {
	const readability = readabilityCandidate(document, options, primaryTitle);
	if (readability !== undefined && passesQuality(readability.quality, "readability")) {
		return {
			preferred: serializeCandidate(readability),
			body: bodyCandidate(document, primaryTitle),
			bodyPassesQuality: passesQuality(analyzeQuality(document.body, primaryTitle), "body"),
		};
	}

	const semantic = bestSemanticCandidate(document, primaryTitle);
	if (semantic !== undefined) {
		return {
			preferred: serializeCandidate(semantic),
			body: bodyCandidate(document, primaryTitle),
			bodyPassesQuality: passesQuality(analyzeQuality(document.body, primaryTitle), "body"),
		};
	}

	const heading = headingCandidate(document, primaryTitle);
	if (heading !== undefined) {
		return {
			preferred: serializeCandidate(heading),
			body: bodyCandidate(document, primaryTitle),
			bodyPassesQuality: passesQuality(analyzeQuality(document.body, primaryTitle), "body"),
		};
	}

	const body = bodyCandidate(document, primaryTitle);
	return {
		body,
		bodyPassesQuality: passesQuality(analyzeQuality(document.body, primaryTitle), "body"),
	};
}

function readabilityCandidate(
	document: Document,
	options: HtmlReadabilityOptions,
	primaryTitle: string | undefined,
): Candidate | undefined {
	const readabilityDocument = document.cloneNode(true) as Document;
	if (!isProbablyReaderable(readabilityDocument)) return undefined;
	const readable = new Readability(readabilityDocument, { charThreshold: options.charThreshold }).parse();
	if (!readable?.content?.trim()) return undefined;
	const root = document.createElement("div");
	root.innerHTML = readable.content;
	const quality = analyzeQuality(root, primaryTitle);
	if (isDilutedByFocusedSemanticRoot(document, quality, primaryTitle)) return undefined;
	const title = normalizeText(readable.title);
	return {
		source: "readability",
		root,
		quality,
		...(title !== undefined ? { title } : {}),
	};
}

function isDilutedByFocusedSemanticRoot(
	document: Document,
	readability: ContentQuality,
	primaryTitle: string | undefined,
): boolean {
	if (primaryTitle === undefined) return false;
	for (const root of document.querySelectorAll(SEMANTIC_SELECTOR)) {
		const quality = analyzeQuality(root, primaryTitle);
		if (!quality.hasPrimaryTitle || quality.mediaCount === 0) continue;
		if (readability.textLength > Math.max(quality.textLength * 4, quality.textLength + 400)) return true;
	}
	return false;
}

function bestSemanticCandidate(document: Document, primaryTitle: string | undefined): Candidate | undefined {
	let best: { candidate: Candidate; score: number } | undefined;
	const seen = new Set<Element>();
	for (const root of document.querySelectorAll(SEMANTIC_SELECTOR)) {
		if (seen.has(root)) continue;
		seen.add(root);
		const quality = analyzeQuality(root, primaryTitle);
		if (!passesQuality(quality, "semantic")) continue;
		const candidate = candidateFromElement("semantic", root, quality);
		const score = qualityScore(quality);
		if (best === undefined || score > best.score) best = { candidate, score };
	}
	return best?.candidate;
}

function headingCandidate(document: Document, primaryTitle: string | undefined): Candidate | undefined {
	const headings = [...document.querySelectorAll("h1")]
		.filter((node) => normalizeText(node.textContent) !== undefined);
	if (headings.length !== 1) return undefined;
	let root = headings[0]?.parentElement ?? null;
	while (root !== null && root !== document.body) {
		const quality = analyzeQuality(root, primaryTitle);
		if (passesQuality(quality, "heading")) return candidateFromElement("heading", root, quality);
		root = root.parentElement;
	}
	return undefined;
}

function bodyCandidate(document: Document, primaryTitle: string | undefined): SelectedHtmlContent {
	const quality = analyzeQuality(document.body, primaryTitle);
	return serializeCandidate(candidateFromElement("body", document.body, quality));
}

function candidateFromElement(source: HtmlTextSource, root: Element, quality: ContentQuality): Candidate {
	const titles = [...root.querySelectorAll("h1")]
		.map((node) => normalizeText(node.textContent))
		.filter((value): value is string => value !== undefined);
	return {
		source,
		root,
		quality,
		...(titles.length === 1 ? { title: titles[0] } : {}),
	};
}

function serializeCandidate(candidate: Candidate): SelectedHtmlContent {
	const root = candidate.root.cloneNode(true) as Element;
	removeHtmlOutputNoise(root);
	return {
		source: candidate.source,
		html: root.innerHTML,
		...(candidate.title !== undefined ? { title: candidate.title } : {}),
		textLength: candidate.quality.textLength,
		blockCount: candidate.quality.paragraphCount + candidate.quality.codeCount + candidate.quality.tableCount,
	};
}

function analyzeQuality(root: Element, primaryTitle: string | undefined): ContentQuality {
	const text = normalizedText(root);
	const textLength = text.length;
	let linkTextLength = 0;
	for (const link of root.querySelectorAll("a")) linkTextLength += normalizedText(link).length;
	const listItems = [...root.querySelectorAll("li")];
	const shortLinkItems = listItems.filter((item) => {
		const itemText = normalizedText(item);
		if (itemText.length === 0 || itemText.length > 100) return false;
		let linked = 0;
		for (const link of item.querySelectorAll("a")) linked += normalizedText(link).length;
		return linked / itemText.length >= 0.6;
	}).length;
	const noiseLength = topLevelNoiseNodes(root)
		.reduce((sum, node) => sum + normalizedText(node).length, 0);
	const comparableTitle = comparableText(primaryTitle);
	return {
		textLength,
		linkDensity: textLength === 0 ? 0 : Math.min(1, linkTextLength / textLength),
		shortLinkListRatio: listItems.length === 0 ? 0 : shortLinkItems / listItems.length,
		headingCount: root.querySelectorAll("h1, h2, h3, h4, h5, h6").length,
		paragraphCount: root.querySelectorAll("p").length,
		codeCount: root.querySelectorAll("pre, code").length,
		tableCount: root.querySelectorAll("table").length,
		mediaCount: root.querySelectorAll("img, picture, video, audio").length,
		formCount: root.querySelectorAll("form, input, select, textarea, button").length,
		noiseRatio: textLength === 0 ? 0 : Math.min(1, noiseLength / textLength),
		hasPrimaryTitle: comparableTitle.length === 0 || comparableText(text).includes(comparableTitle),
	};
}

function passesQuality(quality: ContentQuality, source: HtmlTextSource): boolean {
	if (!quality.hasPrimaryTitle) return false;
	const structured = quality.paragraphCount + quality.codeCount + quality.tableCount;
	const titleOrMedia = quality.headingCount > 0 || quality.mediaCount > 0;
	if (quality.textLength === 0 && quality.mediaCount === 0) return false;
	if (quality.noiseRatio >= 0.5) return false;
	if (quality.formCount > 2 && structured === 0) return false;
	if (quality.linkDensity > 0.55 && quality.paragraphCount < 3) return false;
	if (quality.shortLinkListRatio > 0.6 && quality.paragraphCount < 3) return false;
	if (source === "readability") return quality.textLength >= 120 || structured >= 2;
	if (source === "heading") return titleOrMedia;
	if (source === "semantic") return quality.textLength >= 40 || structured > 0 || titleOrMedia;
	return quality.textLength >= 80 || structured > 0 || titleOrMedia;
}

function qualityScore(quality: ContentQuality): number {
	return Math.min(quality.textLength, 8_000)
		+ (quality.hasPrimaryTitle ? 1_500 : 0)
		+ quality.paragraphCount * 120
		+ quality.headingCount * 80
		+ quality.codeCount * 160
		+ quality.tableCount * 200
		+ quality.mediaCount * 120
		- quality.linkDensity * 2_000
		- quality.shortLinkListRatio * 1_500
		- quality.noiseRatio * 3_000;
}

function topLevelNoiseNodes(root: Element): Element[] {
	const nodes = [...root.querySelectorAll(OUTPUT_NOISE_SELECTORS.join(", "))];
	const noise = new Set(nodes);
	return nodes.filter((node) => {
		let parent = node.parentElement;
		while (parent !== null && parent !== root) {
			if (noise.has(parent)) return false;
			parent = parent.parentElement;
		}
		return true;
	});
}

export function removeHtmlOutputNoise(root: Element): void {
	for (const selector of OUTPUT_NOISE_SELECTORS) {
		root.querySelectorAll(selector).forEach((node) => node.remove());
	}
}

function normalizedText(root: Element): string {
	return normalizeText(root.textContent) ?? "";
}

function normalizeText(value: string | null | undefined): string | undefined {
	const normalized = value?.normalize("NFKC").replace(/\s+/gu, " ").trim();
	return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function comparableText(value: string | null | undefined): string {
	return (value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}
