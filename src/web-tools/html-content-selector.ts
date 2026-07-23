import { isProbablyReaderable, Readability } from "@mozilla/readability";

import type { HtmlReadabilityOptions } from "./types.js";

export type HtmlTextSource = "readability" | "semantic" | "heading" | "body";

export interface SelectedHtmlContent {
	source: HtmlTextSource;
	root: Element;
	title?: string;
	textLength: number;
	blockCount: number;
}

export type HtmlContentSelection =
	| { preferred: SelectedHtmlContent }
	| { body: SelectedHtmlContent; bodyPassesQuality: boolean };

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
	title?: string;
}

interface Candidate {
	source: HtmlTextSource;
	root: Element;
	quality: ContentQuality;
	detached?: boolean;
	title?: string;
}

type QualityFor = (root: Element) => ContentQuality;

interface CandidateRoots {
	semantic: Element[];
	headings: Element[];
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
const OUTPUT_NOISE_SELECTOR = OUTPUT_NOISE_SELECTORS.join(", ");
const QUALITY_STRUCTURE_SELECTOR = [
	"a", "li", "h1", "h2", "h3", "h4", "h5", "h6", "p", "pre", "code", "table",
	"img", "picture", "video", "audio", "form", "input", "select", "textarea", "button",
].join(", ");

/** Generate ordered HTML candidates and select Readability/semantic/heading before exposing body fallback. */
export function selectHtmlContent(
	document: Document,
	options: HtmlReadabilityOptions,
	primaryTitle?: string,
	documentTitle?: string,
): HtmlContentSelection {
	const roots: CandidateRoots = {
		semantic: [...document.querySelectorAll(SEMANTIC_SELECTOR)],
		headings: [...document.querySelectorAll("h1")]
			.filter((node) => normalizeText(node.textContent) !== undefined),
	};
	const qualityCache = new WeakMap<Element, ContentQuality>();
	const qualityFor: QualityFor = (root) => {
		const cached = qualityCache.get(root);
		if (cached !== undefined) return cached;
		const quality = analyzeQuality(root, primaryTitle);
		qualityCache.set(root, quality);
		return quality;
	};
	const readability = readabilityCandidate(document, options, primaryTitle, documentTitle, roots, qualityFor);
	if (readability !== undefined && passesQuality(readability.quality, "readability")) {
		return { preferred: serializeCandidate(readability) };
	}

	const semantic = bestSemanticCandidate(roots.semantic, qualityFor);
	if (semantic !== undefined) {
		return { preferred: serializeCandidate(semantic) };
	}

	const heading = headingCandidate(document, roots.headings, qualityFor);
	if (heading !== undefined) {
		return { preferred: serializeCandidate(heading) };
	}

	const quality = qualityFor(document.body);
	return {
		body: serializeCandidate(candidateFromElement("body", document.body, quality)),
		bodyPassesQuality: passesQuality(quality, "body"),
	};
}

function readabilityInputRoot(document: Document, roots: CandidateRoots, qualityFor: QualityFor): Element {
	let best: { root: Element; score: number } | undefined;
	for (const root of roots.semantic) {
		const quality = qualityFor(root);
		if (!quality.hasPrimaryTitle) continue;
		const score = qualityScore(quality);
		if (best === undefined || score > best.score) best = { root, score };
	}
	if (best !== undefined) return best.root;

	if (roots.headings.length === 1) {
		let headingBest: { root: Element; score: number } | undefined;
		let root = roots.headings[0]?.parentElement ?? null;
		while (root !== null && root !== document.body) {
			const quality = qualityFor(root);
			const score = qualityScore(quality);
			if (quality.hasPrimaryTitle && (headingBest === undefined || score > headingBest.score)) {
				headingBest = { root, score };
			}
			root = root.parentElement;
		}
		if (headingBest !== undefined) return headingBest.root;
	}
	return document.body;
}

function syntheticReadabilityDocument(document: Document, candidateRoot: Element, documentTitle: string | undefined): Document {
	const synthetic = document.cloneNode(false) as Document;
	const html = synthetic.createElement("html");
	const head = synthetic.createElement("head");
	const title = normalizeText(documentTitle);
	if (title !== undefined) {
		const titleNode = synthetic.createElement("title");
		titleNode.textContent = title;
		head.append(titleNode);
	}
	const body = synthetic.createElement("body");
	if (candidateRoot === document.body) {
		for (const child of candidateRoot.childNodes) body.append(child.cloneNode(true));
	} else {
		body.append(candidateRoot.cloneNode(true));
	}
	html.append(head, body);
	synthetic.append(html);
	return synthetic;
}

function readabilityCandidate(
	document: Document,
	options: HtmlReadabilityOptions,
	primaryTitle: string | undefined,
	documentTitle: string | undefined,
	roots: CandidateRoots,
	qualityFor: QualityFor,
): Candidate | undefined {
	const readabilityDocument = syntheticReadabilityDocument(
		document,
		readabilityInputRoot(document, roots, qualityFor),
		documentTitle,
	);
	if (!isProbablyReaderable(readabilityDocument)) return undefined;
	const readable = new Readability(readabilityDocument, { charThreshold: options.charThreshold }).parse();
	if (!readable?.content?.trim()) return undefined;
	const root = document.createElement("div");
	root.innerHTML = readable.content;
	const quality = analyzeQuality(root, primaryTitle);
	if (isDilutedByFocusedSemanticRoot(roots.semantic, quality, primaryTitle, qualityFor)) return undefined;
	const title = normalizeText(readable.title);
	return {
		source: "readability",
		root,
		quality,
		detached: true,
		...(title !== undefined ? { title } : {}),
	};
}

function isDilutedByFocusedSemanticRoot(
	semanticRoots: readonly Element[],
	readability: ContentQuality,
	primaryTitle: string | undefined,
	qualityFor: QualityFor,
): boolean {
	if (primaryTitle === undefined) return false;
	for (const root of semanticRoots) {
		const quality = qualityFor(root);
		if (!quality.hasPrimaryTitle || quality.mediaCount === 0) continue;
		if (readability.textLength > Math.max(quality.textLength * 4, quality.textLength + 400)) return true;
	}
	return false;
}

function bestSemanticCandidate(semanticRoots: readonly Element[], qualityFor: QualityFor): Candidate | undefined {
	let best: { candidate: Candidate; score: number } | undefined;
	const seen = new Set<Element>();
	for (const root of semanticRoots) {
		if (seen.has(root)) continue;
		seen.add(root);
		const quality = qualityFor(root);
		if (!passesQuality(quality, "semantic")) continue;
		const candidate = candidateFromElement("semantic", root, quality);
		const score = qualityScore(quality);
		if (best === undefined || score > best.score) best = { candidate, score };
	}
	return best?.candidate;
}

function headingCandidate(document: Document, headings: readonly Element[], qualityFor: QualityFor): Candidate | undefined {
	if (headings.length !== 1) return undefined;
	let root = headings[0]?.parentElement ?? null;
	while (root !== null && root !== document.body) {
		const quality = qualityFor(root);
		if (passesQuality(quality, "heading")) return candidateFromElement("heading", root, quality);
		root = root.parentElement;
	}
	return undefined;
}

function candidateFromElement(source: HtmlTextSource, root: Element, quality: ContentQuality): Candidate {
	return {
		source,
		root,
		quality,
		...(quality.title !== undefined ? { title: quality.title } : {}),
	};
}

function serializeCandidate(candidate: Candidate): SelectedHtmlContent {
	const root = candidate.detached === true ? candidate.root : candidate.root.cloneNode(true) as Element;
	removeHtmlOutputNoise(root);
	return {
		source: candidate.source,
		root,
		...(candidate.title !== undefined ? { title: candidate.title } : {}),
		textLength: candidate.quality.textLength,
		blockCount: candidate.quality.paragraphCount + candidate.quality.codeCount + candidate.quality.tableCount,
	};
}

function analyzeQuality(root: Element, primaryTitle: string | undefined): ContentQuality {
	const text = normalizedText(root);
	const textLength = text.length;
	const links: Element[] = [];
	const listItems: Element[] = [];
	const h1Titles: string[] = [];
	let headingCount = 0;
	let paragraphCount = 0;
	let codeCount = 0;
	let tableCount = 0;
	let mediaCount = 0;
	let formCount = 0;
	for (const element of root.querySelectorAll(QUALITY_STRUCTURE_SELECTOR)) {
		const tag = element.localName;
		if (tag === "a") links.push(element);
		else if (tag === "li") listItems.push(element);
		else if (/^h[1-6]$/u.test(tag)) {
			headingCount += 1;
			if (tag === "h1") {
				const title = normalizeText(element.textContent);
				if (title !== undefined) h1Titles.push(title);
			}
		}
		else if (tag === "p") paragraphCount += 1;
		else if (tag === "pre" || tag === "code") codeCount += 1;
		else if (tag === "table") tableCount += 1;
		else if (tag === "img" || tag === "picture" || tag === "video" || tag === "audio") mediaCount += 1;
		else formCount += 1;
	}

	let linkTextLength = 0;
	const linkedTextByListItem = new Map<Element, number>();
	const listItemSet = new Set(listItems);
	for (const link of links) {
		const length = normalizedText(link).length;
		linkTextLength += length;
		let parent = link.parentElement;
		while (parent !== null && parent !== root) {
			if (listItemSet.has(parent)) linkedTextByListItem.set(parent, (linkedTextByListItem.get(parent) ?? 0) + length);
			parent = parent.parentElement;
		}
	}
	const shortLinkItems = listItems.filter((item) => {
		const itemText = normalizedText(item);
		return itemText.length > 0
			&& itemText.length <= 100
			&& (linkedTextByListItem.get(item) ?? 0) / itemText.length >= 0.6;
	}).length;
	const noiseLength = topLevelNoiseNodes(root)
		.reduce((sum, node) => sum + normalizedText(node).length, 0);
	const comparableTitle = comparableText(primaryTitle);
	return {
		textLength,
		linkDensity: textLength === 0 ? 0 : Math.min(1, linkTextLength / textLength),
		shortLinkListRatio: listItems.length === 0 ? 0 : shortLinkItems / listItems.length,
		headingCount,
		paragraphCount,
		codeCount,
		tableCount,
		mediaCount,
		formCount,
		noiseRatio: textLength === 0 ? 0 : Math.min(1, noiseLength / textLength),
		hasPrimaryTitle: comparableTitle.length === 0 || comparableText(text).includes(comparableTitle),
		...(h1Titles.length === 1 ? { title: h1Titles[0] } : {}),
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
	const nodes = [...root.querySelectorAll(OUTPUT_NOISE_SELECTOR)];
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
	root.querySelectorAll(OUTPUT_NOISE_SELECTOR).forEach((node) => node.remove());
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
