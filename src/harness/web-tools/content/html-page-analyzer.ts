import type { WebFetchPageKind } from "../core/types.js";
import { isAvatarImage } from "./html-avatar-filter.js";
import { parseImageSrcset, type ImageCandidate } from "./html-image-selection.js";

export type PageKind = WebFetchPageKind;

export interface PageMetadata {
	title?: string;
	description?: string;
	documentTitle?: string;
	heading?: string;
	authors: string[];
	publishedAt?: string;
	modifiedAt?: string;
}

export interface TextCandidate {
	kind: "article_body" | "transcript";
	text: string;
}

export interface KnownOmission {
	kind: "embedded_content" | "structured_data" | "interactive_content";
	reason: "iframe_not_fetched" | "invalid_or_limited" | "client_rendered";
}

export interface PageAnalysis {
	metadata: PageMetadata;
	pageKind: PageKind;
	textCandidates: TextCandidate[];
	imageCandidates: ImageCandidate[];
	omissions: KnownOmission[];
}

const JSON_LD_MAX_TOTAL_CHARS = 256_000;
const JSON_LD_MAX_SCRIPTS = 64;
const JSON_LD_MAX_OBJECTS = 500;
const JSON_LD_MAX_NODES = 2_000;
const JSON_LD_MAX_DEPTH = 20;

interface JsonLdFacts {
	pageKind?: PageKind;
	title?: string;
	titleRank: number;
	description?: string;
	descriptionRank: number;
	authors: string[];
	publishedAt?: string;
	modifiedAt?: string;
	textCandidates: TextCandidate[];
	imageCandidates: ImageCandidate[];
	limited: boolean;
}

interface OpenGraphFacts {
	title?: string;
	description?: string;
	type?: string;
	imageCandidates: ImageCandidate[];
}

interface DomPresence {
	article: boolean;
	video: boolean;
	audio: boolean;
	image: boolean;
	iframe: boolean;
	externalScript: boolean;
}

interface TwitterFacts {
	title?: string;
	description?: string;
	imageCandidates: ImageCandidate[];
}

/** 从已解析页面提取正文、元数据和图片候选，不保留 DOM 节点或脚本源码。 */
export function analyzeHtmlPage(document: Document, finalUrl: string, mime: string, mediaEnabled = true): PageAnalysis {
	const standardElements = [...document.querySelectorAll(
		'base[href], meta, title, script[type="application/ld+json"]',
	)];
	const metaElements = standardElements.filter((element) => element.localName === "meta");
	const jsonLdElements = standardElements.filter((element) => element.localName === "script");
	const baseUrl = resolveDocumentBase(standardElements, finalUrl);
	const documentTitle = textOf(standardElements.find((element) => element.localName === "title") ?? null);
	const headingElements = [...document.querySelectorAll("h1")];
	const headings = headingElements
		.map((node) => normalizeText(node.textContent))
		.filter((value) => value !== undefined);
	const heading = headings.length === 1 ? headings[0] : undefined;
	const domDescription = metaContent(metaElements, "name", "description");
	const visibleBody = visibleBodyFacts(document.body);
	const domPresence = collectDomPresence(document);
	const domAuthors = metaContents(metaElements, "name", "author");
	const openGraph = collectOpenGraph(metaElements, baseUrl, mediaEnabled);
	const twitter = collectTwitter(metaElements, baseUrl, mediaEnabled);
	const jsonLd = collectJsonLd(jsonLdElements, baseUrl, mediaEnabled);
	const domImages = mediaEnabled
		? collectDomImages(document, baseUrl, headingElements.length === 1 ? headingElements[0] : undefined)
		: [];
	const title = openGraph.title ?? jsonLd.title ?? twitter.title ?? documentTitle;
	const description = openGraph.description ?? jsonLd.description ?? twitter.description ?? domDescription;
	const authors = uniqueStrings([...jsonLd.authors, ...domAuthors]);
	const pageKind = selectPageKind(mime, jsonLd.pageKind, openGraph.type, domPresence, visibleBody);
	const omissions: KnownOmission[] = [];
	if (domPresence.iframe) {
		omissions.push({ kind: "embedded_content", reason: "iframe_not_fetched" });
	}
	if (jsonLd.limited) omissions.push({ kind: "structured_data", reason: "invalid_or_limited" });
	if (isClientRenderedShell(title, description, visibleBody, domPresence)) {
		omissions.push({ kind: "interactive_content", reason: "client_rendered" });
	}
	return {
		metadata: {
			...(title !== undefined ? { title } : {}),
			...(description !== undefined ? { description } : {}),
			...(documentTitle !== undefined ? { documentTitle } : {}),
			...(heading !== undefined ? { heading } : {}),
			authors,
			...(jsonLd.publishedAt !== undefined ? { publishedAt: jsonLd.publishedAt } : {}),
			...(jsonLd.modifiedAt !== undefined ? { modifiedAt: jsonLd.modifiedAt } : {}),
		},
		pageKind,
		textCandidates: jsonLd.textCandidates,
		imageCandidates: mediaEnabled
			? [...openGraph.imageCandidates, ...twitter.imageCandidates, ...jsonLd.imageCandidates, ...domImages]
			: [],
		omissions,
	};
}

function collectOpenGraph(metaElements: readonly Element[], baseUrl: string, mediaEnabled: boolean): OpenGraphFacts {
	const facts: OpenGraphFacts = { imageCandidates: [] };
	let currentImage: ImageCandidate | undefined;
	for (const meta of metaElements) {
		const property = meta.getAttribute("property")?.trim().toLowerCase();
		const content = normalizeText(meta.getAttribute("content"));
		if (property === undefined || content === undefined) continue;
		if (property === "og:title" && facts.title === undefined) facts.title = content;
		else if (property === "og:description" && facts.description === undefined) facts.description = content;
		else if (property === "og:type" && facts.type === undefined) facts.type = content;
		else if (mediaEnabled && (property === "og:image" || property === "og:image:url")) {
			currentImage = imageCandidate("primary", "open_graph", content, baseUrl);
			if (currentImage !== undefined) facts.imageCandidates.push(currentImage);
		} else if (mediaEnabled && property === "og:image:secure_url") {
			const secureUrl = resolveHttpUrl(content, baseUrl);
			if (currentImage !== undefined && secureUrl !== undefined) currentImage.secureUrl = secureUrl;
		} else if (mediaEnabled && property === "og:image:width" && currentImage !== undefined) assignWidth(currentImage, content);
		else if (mediaEnabled && property === "og:image:height" && currentImage !== undefined) assignHeight(currentImage, content);
		else if (mediaEnabled && property === "og:image:alt" && currentImage !== undefined) currentImage.alt = content;
	}
	return facts;
}

function collectTwitter(metaElements: readonly Element[], baseUrl: string, mediaEnabled: boolean): TwitterFacts {
	const facts: TwitterFacts = { imageCandidates: [] };
	for (const meta of metaElements) {
		const name = (meta.getAttribute("name") ?? meta.getAttribute("property"))?.trim().toLowerCase();
		const content = normalizeText(meta.getAttribute("content"));
		if (name === undefined || content === undefined) continue;
		if (name === "twitter:title" && facts.title === undefined) facts.title = content;
		else if (name === "twitter:description" && facts.description === undefined) facts.description = content;
		else if (mediaEnabled && (name === "twitter:image" || name === "twitter:image:src")) {
			const candidate = imageCandidate("primary", "twitter", content, baseUrl);
			if (candidate !== undefined) facts.imageCandidates.push(candidate);
		}
	}
	return facts;
}

function collectJsonLd(jsonLdElements: readonly Element[], baseUrl: string, mediaEnabled: boolean): JsonLdFacts {
	const facts: JsonLdFacts = {
		titleRank: -1,
		descriptionRank: -1,
		authors: [],
		textCandidates: [],
		imageCandidates: [],
		limited: false,
	};
	let totalChars = 0;
	let scriptCount = 0;
	let objectCount = 0;
	let nodeCount = 0;
	for (const script of jsonLdElements) {
		const source = script.textContent?.trim() ?? "";
		if (source.length === 0) continue;
		scriptCount += 1;
		if (scriptCount > JSON_LD_MAX_SCRIPTS) {
			facts.limited = true;
			break;
		}
		totalChars += source.length;
		if (totalChars > JSON_LD_MAX_TOTAL_CHARS) {
			facts.limited = true;
			break;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(source);
		} catch {
			facts.limited = true;
			continue;
		}
		const pending: Array<{ value: unknown; depth: number; pageEntity: boolean }> = [{ value: parsed, depth: 0, pageEntity: true }];
		while (pending.length > 0) {
			const item = pending.pop();
			if (item === undefined) break;
			nodeCount += 1;
			if (nodeCount > JSON_LD_MAX_NODES) {
				facts.limited = true;
				pending.length = 0;
				break;
			}
			if (item.depth > JSON_LD_MAX_DEPTH) {
				facts.limited = true;
				continue;
			}
			if (Array.isArray(item.value)) {
				for (const child of item.value) {
					if (nodeCount + pending.length >= JSON_LD_MAX_NODES) {
						facts.limited = true;
						break;
					}
					pending.push({ value: child, depth: item.depth + 1, pageEntity: item.pageEntity });
				}
				continue;
			}
			if (!isRecord(item.value)) continue;
			objectCount += 1;
			if (objectCount > JSON_LD_MAX_OBJECTS) {
				facts.limited = true;
				pending.length = 0;
				break;
			}
			extractJsonLdRecord(item.value, baseUrl, facts, item.pageEntity, mediaEnabled);
			for (const [key, child] of Object.entries(item.value)) {
				if (key === "@context") continue;
				if (Array.isArray(child) || isRecord(child)) {
					if (nodeCount + pending.length >= JSON_LD_MAX_NODES) {
						facts.limited = true;
						break;
					}
					pending.push({
						value: child,
						depth: item.depth + 1,
						pageEntity: item.pageEntity && key === "@graph",
					});
				}
			}
		}
		if (objectCount > JSON_LD_MAX_OBJECTS) break;
	}
	facts.authors = uniqueStrings(facts.authors);
	return facts;
}

function extractJsonLdRecord(
	record: Record<string, unknown>,
	baseUrl: string,
	facts: JsonLdFacts,
	pageEntity: boolean,
	mediaEnabled: boolean,
): void {
	const types = stringValues(record["@type"]).map(normalizeSchemaType);
	const kind = pageKindFromJsonLdTypes(types);
	const rank = pageKindScore(kind);
	if (pageEntity && kind !== undefined && rank > pageKindScore(facts.pageKind)) facts.pageKind = kind;
	const title = firstString(record.headline) ?? firstString(record.name);
	if (pageEntity && title !== undefined && isPageEntity(types) && rank > facts.titleRank) {
		facts.title = title;
		facts.titleRank = rank;
	}
	const description = firstString(record.description);
	if (pageEntity && description !== undefined && isPageEntity(types) && rank > facts.descriptionRank) {
		facts.description = description;
		facts.descriptionRank = rank;
	}
	if (pageEntity && isPageEntity(types)) {
		for (const author of authorNames(record.author)) facts.authors.push(author);
		const publishedAt = firstString(record.datePublished) ?? firstString(record.uploadDate);
		if (facts.publishedAt === undefined && publishedAt !== undefined) facts.publishedAt = publishedAt;
		const modifiedAt = firstString(record.dateModified);
		if (facts.modifiedAt === undefined && modifiedAt !== undefined) facts.modifiedAt = modifiedAt;
		const articleBody = firstString(record.articleBody);
		if (articleBody !== undefined) facts.textCandidates.push({ kind: "article_body", text: articleBody });
		const transcript = firstString(record.transcript);
		if (transcript !== undefined) facts.textCandidates.push({ kind: "transcript", text: transcript });
	}
	if (!mediaEnabled) return;
	collectJsonLdImages(record.image, "primary", baseUrl, facts.imageCandidates);
	collectJsonLdImages(record.thumbnailUrl, "thumbnail", baseUrl, facts.imageCandidates);
	if (types.includes("imageobject")) {
		collectJsonLdImages(record.url, "primary", baseUrl, facts.imageCandidates);
		collectJsonLdImages(record.contentUrl, "content", baseUrl, facts.imageCandidates);
	}
}

function collectJsonLdImages(value: unknown, role: ImageCandidate["role"], baseUrl: string, output: ImageCandidate[]): void {
	for (const item of arrayValues(value)) {
		if (typeof item === "string") {
			const candidate = imageCandidate(role, "json_ld", item, baseUrl);
			if (candidate !== undefined) output.push(candidate);
			continue;
		}
		if (!isRecord(item)) continue;
		const rawUrl = firstString(item.contentUrl) ?? firstString(item.url);
		if (rawUrl === undefined) continue;
		const candidate = imageCandidate(role, "json_ld", rawUrl, baseUrl);
		if (candidate === undefined) continue;
		const width = dimensionValue(item.width);
		const height = dimensionValue(item.height);
		const alt = firstString(item.caption) ?? firstString(item.name);
		if (width !== undefined) candidate.width = width;
		if (height !== undefined) candidate.height = height;
		if (alt !== undefined) candidate.alt = alt;
		output.push(candidate);
	}
}

function collectDomImages(document: Document, baseUrl: string, primaryHeading: Element | undefined): ImageCandidate[] {
	const candidates: ImageCandidate[] = [];
	const mediaElements = [...document.querySelectorAll("img, video[poster], picture source")];
	const images = mediaElements.filter((element) =>
		element.localName === "img" && (element.hasAttribute("src") || element.hasAttribute("srcset"))
	);
	const videos = mediaElements.filter((element) => element.localName === "video");
	const sources = mediaElements.filter((element) => element.localName === "source");
	for (const image of images) {
		const candidate = imageCandidate("source", "dom", image.getAttribute("src"), baseUrl);
		if (candidate !== undefined) {
			copyImageAttributes(image, candidate, primaryHeading, baseUrl);
			candidates.push(candidate);
		}
		for (const item of parseImageSrcset(image.getAttribute("srcset"))) {
			const srcsetCandidate = imageCandidate("source", "dom", item.url, baseUrl);
			if (srcsetCandidate === undefined) continue;
			copyImageAttributes(image, srcsetCandidate, primaryHeading, baseUrl);
			if (item.width !== undefined) srcsetCandidate.width = item.width;
			candidates.push(srcsetCandidate);
		}
	}
	for (const video of videos) {
		const poster = imageCandidate("poster", "dom", video.getAttribute("poster"), baseUrl);
		if (poster !== undefined) {
			copyImageAttributes(video, poster, primaryHeading, baseUrl);
			candidates.push(poster);
		}
	}
	for (const source of sources.filter((element) => element.closest("picture") !== null)) {
		const fallback = source.closest("picture")?.querySelector("img") ?? undefined;
		const items: Array<{ url: string; width?: number }> = [
			...stringValues(source.getAttribute("src")).map((url) => ({ url })),
			...parseImageSrcset(source.getAttribute("srcset")),
		];
		for (const item of items) {
			const candidate = imageCandidate("source", "dom", item.url, baseUrl);
			if (candidate !== undefined) {
				if (fallback !== undefined) copyImageAttributes(fallback, candidate, primaryHeading, baseUrl);
				copyImageAttributes(source, candidate, primaryHeading, baseUrl);
				if (item.width !== undefined) candidate.width = item.width;
				candidates.push(candidate);
			}
		}
	}
	return candidates;
}

function selectPageKind(
	mime: string,
	jsonLdKind: PageKind | undefined,
	openGraphType: string | undefined,
	domPresence: DomPresence,
	visibleBody: VisibleBodyFacts,
): PageKind {
	const mimeKind = pageKindFromMime(mime);
	if (mimeKind !== undefined) return mimeKind;
	if (jsonLdKind !== undefined) return jsonLdKind;
	const openGraphKind = pageKindFromOpenGraph(openGraphType);
	if (openGraphKind !== undefined) return openGraphKind;
	if (domPresence.article) return "article";
	if (domPresence.video) return "video";
	if (domPresence.audio) return "audio";
	if (isImageDominantDocument(domPresence, visibleBody)) return "image";
	return "generic";
}

function isImageDominantDocument(domPresence: DomPresence, visibleBody: VisibleBodyFacts): boolean {
	return domPresence.image && visibleBody.textLength < 160;
}

function pageKindFromMime(mime: string): PageKind | undefined {
	const normalized = mime.toLowerCase();
	if (normalized.startsWith("image/")) return "image";
	if (normalized.startsWith("video/")) return "video";
	if (normalized.startsWith("audio/")) return "audio";
	return undefined;
}

function pageKindFromJsonLdTypes(types: string[]): PageKind | undefined {
	if (types.includes("videoobject")) return "video";
	if (types.includes("audioobject")) return "audio";
	if (types.includes("imageobject")) return "image";
	if (types.some((value) => ARTICLE_TYPES.has(value))) return "article";
	return undefined;
}

const ARTICLE_TYPES = new Set([
	"article",
	"newsarticle",
	"blogposting",
	"report",
	"review",
	"scholarlyarticle",
	"techarticle",
	"socialmediaposting",
]);

function pageKindFromOpenGraph(value: string | undefined): PageKind | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === undefined) return undefined;
	if (normalized === "article" || normalized.startsWith("article.")) return "article";
	if (normalized === "video" || normalized.startsWith("video.")) return "video";
	if (normalized === "audio" || normalized.startsWith("audio.") || normalized.startsWith("music.")) return "audio";
	if (normalized === "image" || normalized.startsWith("image.")) return "image";
	return undefined;
}

function pageKindScore(kind: PageKind | undefined): number {
	if (kind === "video") return 4;
	if (kind === "audio") return 3;
	if (kind === "article") return 2;
	if (kind === "image") return 1;
	return 0;
}

function normalizeSchemaType(value: string): string {
	const normalized = value.trim().toLowerCase();
	return normalized.split(/[/:#]/u).filter((part) => part.length > 0).at(-1) ?? normalized;
}

function isPageEntity(types: string[]): boolean {
	return types.some((value) =>
		ARTICLE_TYPES.has(value)
		|| value === "videoobject"
		|| value === "audioobject"
		|| value === "imageobject"
		|| value === "webpage"
	);
}

function resolveDocumentBase(standardElements: readonly Element[], finalUrl: string): string {
	const declared = standardElements.find((element) => element.localName === "base")?.getAttribute("href");
	return resolveHttpUrl(declared, finalUrl) ?? finalUrl;
}

function imageCandidate(
	role: ImageCandidate["role"],
	source: ImageCandidate["source"],
	value: string | null,
	baseUrl: string,
): ImageCandidate | undefined {
	const url = resolveHttpUrl(value, baseUrl);
	return url === undefined ? undefined : { role, source, url };
}

function copyImageAttributes(
	node: Element,
	candidate: ImageCandidate,
	primaryHeading: Element | undefined,
	baseUrl: string,
): void {
	const width = positiveDimension(node.getAttribute("width"));
	const height = positiveDimension(node.getAttribute("height"));
	const alt = normalizeText(node.getAttribute("alt"));
	if (width !== undefined) candidate.width = width;
	if (height !== undefined) candidate.height = height;
	if (alt !== undefined) candidate.alt = alt;
	if (primaryHeading !== undefined) {
		const distance = elementDistance(node, primaryHeading);
		candidate.titleDistance = candidate.titleDistance === undefined
			? distance
			: Math.min(candidate.titleDistance, distance);
	}
	candidate.presentation = candidate.presentation === true
		|| node.getAttribute("role")?.toLowerCase() === "presentation";
	candidate.hidden = candidate.hidden === true
		|| node.closest('[hidden], [aria-hidden="true"]') !== null
		|| /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:;|$)/iu.test(node.getAttribute("style") ?? "");
	candidate.likelyAvatar = candidate.likelyAvatar === true
		|| node.tagName.toLowerCase() === "img" && isAvatarImage(node, baseUrl);
	const hints = [
		node.getAttribute("id"),
		node.getAttribute("class"),
		node.getAttribute("alt"),
		node.getAttribute("src"),
	].filter((value): value is string => value !== null).join(" ");
	candidate.likelyDecorative = candidate.likelyDecorative === true
		|| node.hasAttribute("alt") && node.getAttribute("alt")?.trim() === ""
		|| /(?:^|[^a-z])(logo|icon|sprite|emoji|badge|decorative|decoration)(?:[^a-z]|$)/iu.test(hints);
}

function assignWidth(candidate: ImageCandidate, value: string): void {
	const width = positiveDimension(value);
	if (width !== undefined) candidate.width = width;
}

function assignHeight(candidate: ImageCandidate, value: string): void {
	const height = positiveDimension(value);
	if (height !== undefined) candidate.height = height;
}

function elementDistance(left: Element, right: Element): number {
	const leftAncestors = new Map<Node, number>();
	let current: Node | null = left;
	let distance = 0;
	while (current !== null) {
		leftAncestors.set(current, distance);
		current = current.parentNode;
		distance += 1;
	}
	current = right;
	distance = 0;
	while (current !== null) {
		const leftDistance = leftAncestors.get(current);
		if (leftDistance !== undefined) return leftDistance + distance;
		current = current.parentNode;
		distance += 1;
	}
	return Number.MAX_SAFE_INTEGER;
}

function resolveHttpUrl(value: string | null | undefined, baseUrl: string): string | undefined {
	const normalized = normalizeText(value);
	if (normalized === undefined) return undefined;
	try {
		const url = new URL(normalized, baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

function metaContent(metaElements: readonly Element[], attribute: "name" | "property", key: string): string | undefined {
	return metaContents(metaElements, attribute, key)[0];
}

function metaContents(metaElements: readonly Element[], attribute: "name" | "property", key: string): string[] {
	const expected = key.toLowerCase();
	const values: string[] = [];
	for (const meta of metaElements) {
		if (meta.getAttribute(attribute)?.trim().toLowerCase() !== expected) continue;
		const content = normalizeText(meta.getAttribute("content"));
		if (content !== undefined) values.push(content);
	}
	return values;
}

function textOf(node: Element | null): string | undefined {
	return normalizeText(node?.textContent ?? null);
}

function normalizeText(value: string | null | undefined): string | undefined {
	const normalized = value?.normalize("NFKC").replace(/\s+/gu, " ").trim();
	return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function positiveDimension(value: string | null): number | undefined {
	if (value === null || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function dimensionValue(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
	return typeof value === "string" ? positiveDimension(value) : undefined;
}

function firstString(value: unknown): string | undefined {
	return stringValues(value)[0];
}

function stringValues(value: unknown): string[] {
	if (typeof value === "string") {
		const normalized = normalizeText(value);
		return normalized === undefined ? [] : [normalized];
	}
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => stringValues(item));
}

function arrayValues(value: unknown): unknown[] {
	return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function authorNames(value: unknown): string[] {
	const names: string[] = [];
	for (const author of arrayValues(value)) {
		if (typeof author === "string") {
			const normalized = normalizeText(author);
			if (normalized !== undefined) names.push(normalized);
		} else if (isRecord(author)) {
			const name = firstString(author.name);
			if (name !== undefined) names.push(name);
		}
	}
	return names;
}

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	return values.filter((item) => {
		const key = item.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface VisibleBodyFacts {
	textLength: number;
	hasMedia: boolean;
}

function visibleBodyFacts(body: Element): VisibleBodyFacts {
	let textLength = 0;
	let hasMedia = false;
	let previousWhitespace = true;
	const pending: Node[] = [...body.childNodes];
	while (pending.length > 0 && (textLength < 160 || !hasMedia)) {
		const node = pending.pop();
		if (node === undefined) break;
		if (node.nodeType === 3) {
			const value = node.nodeValue ?? "";
			for (let index = 0; index < value.length && textLength < 160; index += 1) {
				const whitespace = /\s/u.test(value[index] ?? "");
				if (!whitespace || !previousWhitespace) textLength += 1;
				previousWhitespace = whitespace;
			}
			continue;
		}
		if (node.nodeType !== 1) continue;
		const element = node as Element;
		if (["script", "style", "template", "noscript"].includes(element.localName)) continue;
		if (["img", "picture", "video", "audio"].includes(element.localName)) hasMedia = true;
		for (const child of element.childNodes) pending.push(child);
	}
	return { textLength: previousWhitespace && textLength > 0 ? textLength - 1 : textLength, hasMedia };
}

function collectDomPresence(document: Document): DomPresence {
	const presence: DomPresence = {
		article: false,
		video: false,
		audio: false,
		image: false,
		iframe: false,
		externalScript: false,
	};
	for (const element of document.querySelectorAll(
		'article, [itemprop="articleBody"], video, audio, picture, img, iframe, script[src]',
	)) {
		const tag = element.localName;
		if (tag === "article" || element.getAttribute("itemprop") === "articleBody") presence.article = true;
		if (tag === "video") presence.video = true;
		else if (tag === "audio") presence.audio = true;
		else if (tag === "picture" || tag === "img") presence.image = true;
		else if (tag === "iframe") presence.iframe = true;
		else if (tag === "script") presence.externalScript = true;
	}
	return presence;
}

function isClientRenderedShell(
	title: string | undefined,
	description: string | undefined,
	visibleBody: VisibleBodyFacts,
	domPresence: DomPresence,
): boolean {
	if (title === undefined && description === undefined) return false;
	if (!domPresence.externalScript) return false;
	return visibleBody.textLength === 0 && !visibleBody.hasMedia;
}
