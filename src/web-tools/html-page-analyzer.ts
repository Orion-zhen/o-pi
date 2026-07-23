import type { WebFetchPageKind } from "./types.js";
import { isAvatarImage } from "./html-avatar-filter.js";

export type PageKind = WebFetchPageKind;

export type PageEvidenceSource =
	| "dom"
	| "readability"
	| "open_graph"
	| "twitter"
	| "json_ld"
	| "template"
	| "noscript";

export interface EvidenceValue<T> {
	value: T;
	source: PageEvidenceSource;
}

export interface PageMetadata {
	title?: EvidenceValue<string>;
	description?: EvidenceValue<string>;
	documentTitle?: EvidenceValue<string>;
	heading?: EvidenceValue<string>;
	domDescription?: EvidenceValue<string>;
	canonicalUrl: EvidenceValue<string>;
	authors: Array<EvidenceValue<string>>;
	publishedAt?: EvidenceValue<string>;
	modifiedAt?: EvidenceValue<string>;
	openGraph?: {
		title?: EvidenceValue<string>;
		description?: EvidenceValue<string>;
		type?: EvidenceValue<string>;
		url?: EvidenceValue<string>;
	};
	twitter?: {
		card?: EvidenceValue<string>;
		title?: EvidenceValue<string>;
		description?: EvidenceValue<string>;
	};
	jsonLd?: {
		title?: EvidenceValue<string>;
		description?: EvidenceValue<string>;
		authors: Array<EvidenceValue<string>>;
		publishedAt?: EvidenceValue<string>;
		modifiedAt?: EvidenceValue<string>;
	};
}

export interface TextCandidate {
	kind: "article_body" | "transcript";
	text: string;
	source: PageEvidenceSource;
}

export interface MediaCandidate {
	kind: "image" | "video" | "audio";
	role: "primary" | "thumbnail" | "poster" | "content" | "embed" | "source";
	source: PageEvidenceSource;
	url: string;
	secureUrl?: string;
	mimeType?: string;
	width?: number;
	height?: number;
	alt?: string;
	titleDistance?: number;
	presentation?: boolean;
	hidden?: boolean;
	likelyAvatar?: boolean;
	likelyDecorative?: boolean;
}

export type DeferredFragmentKind = "template_for" | "shadow_root" | "noscript";

export type DeferredFragmentStatus = "resolved" | "skipped";

export type DeferredFragmentReason =
	| "target_replaced"
	| "shadow_root_expanded"
	| "noscript_expanded"
	| "missing_target"
	| "ambiguous_target"
	| "duplicate_target"
	| "cyclic_target"
	| "invalid_declaration"
	| "fragment_limit"
	| "depth_limit";

export interface DeferredFragmentEvidence {
	kind: DeferredFragmentKind;
	status: DeferredFragmentStatus;
	reason: DeferredFragmentReason;
}

export interface DeferredEvidence {
	discovered: number;
	resolved: number;
	skipped: number;
	limited: boolean;
	fragments: DeferredFragmentEvidence[];
}

export interface KnownOmission {
	kind: "embedded_content" | "structured_data" | "interactive_content";
	reason: "iframe_not_fetched" | "invalid_or_limited" | "client_rendered";
}

export interface PageAnalysis {
	metadata: PageMetadata;
	pageKind: PageKind;
	textCandidates: TextCandidate[];
	mediaCandidates: MediaCandidate[];
	deferred: DeferredEvidence;
	omissions: KnownOmission[];
}

const JSON_LD_MAX_TOTAL_CHARS = 256_000;
const JSON_LD_MAX_SCRIPTS = 64;
const JSON_LD_MAX_OBJECTS = 500;
const JSON_LD_MAX_NODES = 2_000;
const JSON_LD_MAX_DEPTH = 20;

interface JsonLdFacts {
	pageKind?: PageKind;
	title?: EvidenceValue<string>;
	titleRank: number;
	description?: EvidenceValue<string>;
	descriptionRank: number;
	authors: Array<EvidenceValue<string>>;
	publishedAt?: EvidenceValue<string>;
	modifiedAt?: EvidenceValue<string>;
	textCandidates: TextCandidate[];
	mediaCandidates: MediaCandidate[];
	limited: boolean;
}

interface OpenGraphFacts {
	title?: EvidenceValue<string>;
	description?: EvidenceValue<string>;
	type?: EvidenceValue<string>;
	url?: EvidenceValue<string>;
	mediaCandidates: MediaCandidate[];
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
	card?: EvidenceValue<string>;
	title?: EvidenceValue<string>;
	description?: EvidenceValue<string>;
	mediaCandidates: MediaCandidate[];
}

/** Analyze one already-parsed HTML response without retaining DOM nodes or raw scripts. */
export function analyzeHtmlPage(document: Document, finalUrl: string, mime: string): PageAnalysis {
	const standardElements = [...document.querySelectorAll(
		'base[href], link[href], meta, title, script[type="application/ld+json"]',
	)];
	const metaElements = standardElements.filter((element) => element.localName === "meta");
	const jsonLdElements = standardElements.filter((element) => element.localName === "script");
	const baseUrl = resolveDocumentBase(standardElements, finalUrl);
	const documentTitle = evidence(textOf(standardElements.find((element) => element.localName === "title") ?? null), "dom");
	const headingElements = [...document.querySelectorAll("h1")];
	const headings = headingElements
		.map((node) => normalizeText(node.textContent))
		.filter((value) => value !== undefined);
	const heading = headings.length === 1 ? evidence(headings[0], "dom") : undefined;
	const domDescription = evidence(metaContent(metaElements, "name", "description"), "dom");
	const visibleBody = visibleBodyFacts(document.body);
	const domPresence = collectDomPresence(document);
	const domAuthors = metaContents(metaElements, "name", "author").map((value) => ({ value, source: "dom" as const }));
	const openGraph = collectOpenGraph(metaElements, baseUrl);
	const twitter = collectTwitter(metaElements, baseUrl);
	const jsonLd = collectJsonLd(jsonLdElements, baseUrl);
	const domMedia = collectDomMedia(document, baseUrl, headingElements.length === 1 ? headingElements[0] : undefined);
	const canonical = linkHref(standardElements, "canonical", baseUrl)
		?? openGraph.url
		?? { value: normalizeFinalUrl(finalUrl), source: "dom" as const };
	const title = openGraph.title ?? jsonLd.title ?? twitter.title ?? documentTitle;
	const description = openGraph.description ?? jsonLd.description ?? twitter.description ?? domDescription;
	const authors = uniqueEvidence([...jsonLd.authors, ...domAuthors]);
	const pageKind = selectPageKind(mime, jsonLd.pageKind, openGraph.type?.value, domPresence, visibleBody);
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
			...(domDescription !== undefined ? { domDescription } : {}),
			canonicalUrl: canonical,
			authors,
			...(jsonLd.publishedAt !== undefined ? { publishedAt: jsonLd.publishedAt } : {}),
			...(jsonLd.modifiedAt !== undefined ? { modifiedAt: jsonLd.modifiedAt } : {}),
			...(hasOpenGraphFacts(openGraph) ? {
				openGraph: {
					...(openGraph.title !== undefined ? { title: openGraph.title } : {}),
					...(openGraph.description !== undefined ? { description: openGraph.description } : {}),
					...(openGraph.type !== undefined ? { type: openGraph.type } : {}),
					...(openGraph.url !== undefined ? { url: openGraph.url } : {}),
				},
			} : {}),
			...(hasTwitterFacts(twitter) ? {
				twitter: {
					...(twitter.card !== undefined ? { card: twitter.card } : {}),
					...(twitter.title !== undefined ? { title: twitter.title } : {}),
					...(twitter.description !== undefined ? { description: twitter.description } : {}),
				},
			} : {}),
			...(hasJsonLdFacts(jsonLd) ? {
				jsonLd: {
					...(jsonLd.title !== undefined ? { title: jsonLd.title } : {}),
					...(jsonLd.description !== undefined ? { description: jsonLd.description } : {}),
					authors: jsonLd.authors,
					...(jsonLd.publishedAt !== undefined ? { publishedAt: jsonLd.publishedAt } : {}),
					...(jsonLd.modifiedAt !== undefined ? { modifiedAt: jsonLd.modifiedAt } : {}),
				},
			} : {}),
		},
		pageKind,
		textCandidates: jsonLd.textCandidates,
		mediaCandidates: [...openGraph.mediaCandidates, ...twitter.mediaCandidates, ...jsonLd.mediaCandidates, ...domMedia],
		deferred: {
			discovered: 0,
			resolved: 0,
			skipped: 0,
			limited: false,
			fragments: [],
		},
		omissions,
	};
}

function collectOpenGraph(metaElements: readonly Element[], baseUrl: string): OpenGraphFacts {
	const facts: OpenGraphFacts = { mediaCandidates: [] };
	let currentImage: MediaCandidate | undefined;
	let currentVideo: MediaCandidate | undefined;
	let currentAudio: MediaCandidate | undefined;
	for (const meta of metaElements) {
		const property = meta.getAttribute("property")?.trim().toLowerCase();
		const content = normalizeText(meta.getAttribute("content"));
		if (property === undefined || content === undefined) continue;
		if (property === "og:title" && facts.title === undefined) facts.title = { value: content, source: "open_graph" };
		else if (property === "og:description" && facts.description === undefined) facts.description = { value: content, source: "open_graph" };
		else if (property === "og:type" && facts.type === undefined) facts.type = { value: content, source: "open_graph" };
		else if (property === "og:url" && facts.url === undefined) {
			const url = evidenceUrl(content, baseUrl, "open_graph");
			if (url !== undefined) facts.url = url;
		}
		else if (property === "og:image" || property === "og:image:url") {
			currentImage = mediaCandidate("image", "primary", "open_graph", content, baseUrl);
			if (currentImage !== undefined) facts.mediaCandidates.push(currentImage);
		} else if (property === "og:image:secure_url") {
			const secureUrl = resolveHttpUrl(content, baseUrl);
			if (currentImage !== undefined && secureUrl !== undefined) currentImage.secureUrl = secureUrl;
		} else if (property === "og:image:type" && currentImage !== undefined) currentImage.mimeType = content.toLowerCase();
		else if (property === "og:image:width" && currentImage !== undefined) assignWidth(currentImage, content);
		else if (property === "og:image:height" && currentImage !== undefined) assignHeight(currentImage, content);
		else if (property === "og:image:alt" && currentImage !== undefined) currentImage.alt = content;
		else if (property === "og:video" || property === "og:video:url") {
			currentVideo = mediaCandidate("video", "content", "open_graph", content, baseUrl);
			if (currentVideo !== undefined) facts.mediaCandidates.push(currentVideo);
		} else if (property === "og:video:secure_url") {
			const secureUrl = resolveHttpUrl(content, baseUrl);
			if (currentVideo !== undefined && secureUrl !== undefined) currentVideo.secureUrl = secureUrl;
		} else if (property === "og:video:type" && currentVideo !== undefined) currentVideo.mimeType = content.toLowerCase();
		else if (property === "og:video:width" && currentVideo !== undefined) assignWidth(currentVideo, content);
		else if (property === "og:video:height" && currentVideo !== undefined) assignHeight(currentVideo, content);
		else if (property === "og:audio" || property === "og:audio:url") {
			currentAudio = mediaCandidate("audio", "content", "open_graph", content, baseUrl);
			if (currentAudio !== undefined) facts.mediaCandidates.push(currentAudio);
		} else if (property === "og:audio:secure_url") {
			const secureUrl = resolveHttpUrl(content, baseUrl);
			if (currentAudio !== undefined && secureUrl !== undefined) currentAudio.secureUrl = secureUrl;
		} else if (property === "og:audio:type" && currentAudio !== undefined) currentAudio.mimeType = content.toLowerCase();
	}
	return facts;
}

function collectTwitter(metaElements: readonly Element[], baseUrl: string): TwitterFacts {
	const facts: TwitterFacts = { mediaCandidates: [] };
	for (const meta of metaElements) {
		const name = (meta.getAttribute("name") ?? meta.getAttribute("property"))?.trim().toLowerCase();
		const content = normalizeText(meta.getAttribute("content"));
		if (name === undefined || content === undefined) continue;
		if (name === "twitter:card" && facts.card === undefined) facts.card = { value: content, source: "twitter" };
		else if (name === "twitter:title" && facts.title === undefined) facts.title = { value: content, source: "twitter" };
		else if (name === "twitter:description" && facts.description === undefined) facts.description = { value: content, source: "twitter" };
		else if (name === "twitter:image" || name === "twitter:image:src") {
			const candidate = mediaCandidate("image", "primary", "twitter", content, baseUrl);
			if (candidate !== undefined) facts.mediaCandidates.push(candidate);
		}
	}
	return facts;
}

function collectJsonLd(jsonLdElements: readonly Element[], baseUrl: string): JsonLdFacts {
	const facts: JsonLdFacts = {
		titleRank: -1,
		descriptionRank: -1,
		authors: [],
		textCandidates: [],
		mediaCandidates: [],
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
			extractJsonLdRecord(item.value, baseUrl, facts, item.pageEntity);
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
	facts.authors = uniqueEvidence(facts.authors);
	return facts;
}

function extractJsonLdRecord(
	record: Record<string, unknown>,
	baseUrl: string,
	facts: JsonLdFacts,
	pageEntity: boolean,
): void {
	const types = stringValues(record["@type"]).map(normalizeSchemaType);
	const kind = pageKindFromJsonLdTypes(types);
	const rank = pageKindScore(kind);
	if (pageEntity && kind !== undefined && rank > pageKindScore(facts.pageKind)) facts.pageKind = kind;
	const title = firstString(record.headline) ?? firstString(record.name);
	if (pageEntity && title !== undefined && isPageEntity(types) && rank > facts.titleRank) {
		facts.title = { value: title, source: "json_ld" };
		facts.titleRank = rank;
	}
	const description = firstString(record.description);
	if (pageEntity && description !== undefined && isPageEntity(types) && rank > facts.descriptionRank) {
		facts.description = { value: description, source: "json_ld" };
		facts.descriptionRank = rank;
	}
	if (pageEntity && isPageEntity(types)) {
		for (const author of authorNames(record.author)) facts.authors.push({ value: author, source: "json_ld" });
		const publishedAt = firstString(record.datePublished) ?? firstString(record.uploadDate);
		if (facts.publishedAt === undefined && publishedAt !== undefined) facts.publishedAt = { value: publishedAt, source: "json_ld" };
		const modifiedAt = firstString(record.dateModified);
		if (facts.modifiedAt === undefined && modifiedAt !== undefined) facts.modifiedAt = { value: modifiedAt, source: "json_ld" };
		const articleBody = firstString(record.articleBody);
		if (articleBody !== undefined) facts.textCandidates.push({ kind: "article_body", text: articleBody, source: "json_ld" });
		const transcript = firstString(record.transcript);
		if (transcript !== undefined) facts.textCandidates.push({ kind: "transcript", text: transcript, source: "json_ld" });
	}
	collectJsonLdImages(record.image, "primary", baseUrl, facts.mediaCandidates);
	collectJsonLdImages(record.thumbnailUrl, "thumbnail", baseUrl, facts.mediaCandidates);
	if (types.includes("imageobject")) {
		collectJsonLdImages(record.url, "primary", baseUrl, facts.mediaCandidates);
		collectJsonLdImages(record.contentUrl, "content", baseUrl, facts.mediaCandidates);
	}
	if (types.includes("videoobject")) {
		pushJsonLdMedia(record.contentUrl, "video", "content", baseUrl, facts.mediaCandidates);
		pushJsonLdMedia(record.embedUrl, "video", "embed", baseUrl, facts.mediaCandidates);
	}
	if (types.includes("audioobject")) {
		pushJsonLdMedia(record.contentUrl, "audio", "content", baseUrl, facts.mediaCandidates);
		pushJsonLdMedia(record.embedUrl, "audio", "embed", baseUrl, facts.mediaCandidates);
	}
}

function collectJsonLdImages(value: unknown, role: MediaCandidate["role"], baseUrl: string, output: MediaCandidate[]): void {
	for (const item of arrayValues(value)) {
		if (typeof item === "string") {
			const candidate = mediaCandidate("image", role, "json_ld", item, baseUrl);
			if (candidate !== undefined) output.push(candidate);
			continue;
		}
		if (!isRecord(item)) continue;
		const rawUrl = firstString(item.contentUrl) ?? firstString(item.url);
		if (rawUrl === undefined) continue;
		const candidate = mediaCandidate("image", role, "json_ld", rawUrl, baseUrl);
		if (candidate === undefined) continue;
		const mimeType = firstString(item.encodingFormat);
		const width = dimensionValue(item.width);
		const height = dimensionValue(item.height);
		const alt = firstString(item.caption) ?? firstString(item.name);
		if (mimeType !== undefined) candidate.mimeType = mimeType.toLowerCase();
		if (width !== undefined) candidate.width = width;
		if (height !== undefined) candidate.height = height;
		if (alt !== undefined) candidate.alt = alt;
		output.push(candidate);
	}
}

function pushJsonLdMedia(
	value: unknown,
	kind: MediaCandidate["kind"],
	role: MediaCandidate["role"],
	baseUrl: string,
	output: MediaCandidate[],
): void {
	for (const rawUrl of stringValues(value)) {
		const candidate = mediaCandidate(kind, role, "json_ld", rawUrl, baseUrl);
		if (candidate !== undefined) output.push(candidate);
	}
}

function collectDomMedia(document: Document, baseUrl: string, primaryHeading: Element | undefined): MediaCandidate[] {
	const candidates: MediaCandidate[] = [];
	const mediaElements = [...document.querySelectorAll("img, video, audio, source")];
	const images = mediaElements.filter((element) =>
		element.localName === "img" && (element.hasAttribute("src") || element.hasAttribute("srcset"))
	);
	const videos = mediaElements.filter((element) => element.localName === "video");
	const audios = mediaElements.filter((element) => element.localName === "audio");
	const sources = mediaElements.filter((element) => element.localName === "source");
	for (const image of images) {
		const candidate = mediaCandidate("image", "source", "dom", image.getAttribute("src"), baseUrl);
		if (candidate !== undefined) {
			copyDomMediaAttributes(image, candidate, primaryHeading, baseUrl);
			candidates.push(candidate);
		}
		for (const item of parseImageSrcset(image.getAttribute("srcset"))) {
			const srcsetCandidate = mediaCandidate("image", "source", "dom", item.url, baseUrl);
			if (srcsetCandidate === undefined) continue;
			copyDomMediaAttributes(image, srcsetCandidate, primaryHeading, baseUrl);
			if (item.width !== undefined) srcsetCandidate.width = item.width;
			candidates.push(srcsetCandidate);
		}
	}
	for (const video of videos) {
		const poster = mediaCandidate("image", "poster", "dom", video.getAttribute("poster"), baseUrl);
		if (poster !== undefined) {
			copyDomMediaAttributes(video, poster, primaryHeading, baseUrl);
			candidates.push(poster);
		}
		const source = mediaCandidate("video", "source", "dom", video.getAttribute("src"), baseUrl);
		if (source !== undefined) {
			copyDomMediaAttributes(video, source, primaryHeading, baseUrl);
			candidates.push(source);
		}
	}
	for (const source of sources.filter((element) => element.hasAttribute("src") && element.closest("video") !== null)) {
		const candidate = mediaCandidate("video", "source", "dom", source.getAttribute("src"), baseUrl);
		if (candidate !== undefined) {
			copyDomMediaAttributes(source, candidate, primaryHeading, baseUrl);
			candidates.push(candidate);
		}
	}
	for (const audio of audios) {
		const candidate = mediaCandidate("audio", "source", "dom", audio.getAttribute("src"), baseUrl);
		if (candidate !== undefined) {
			copyDomMediaAttributes(audio, candidate, primaryHeading, baseUrl);
			candidates.push(candidate);
		}
	}
	for (const source of sources.filter((element) => element.hasAttribute("src") && element.closest("audio") !== null)) {
		const candidate = mediaCandidate("audio", "source", "dom", source.getAttribute("src"), baseUrl);
		if (candidate !== undefined) {
			copyDomMediaAttributes(source, candidate, primaryHeading, baseUrl);
			candidates.push(candidate);
		}
	}
	for (const source of sources.filter((element) => element.closest("picture") !== null)) {
		const fallback = source.closest("picture")?.querySelector("img") ?? undefined;
		const items: Array<{ url: string; width?: number }> = [
			...stringValues(source.getAttribute("src")).map((url) => ({ url })),
			...parseImageSrcset(source.getAttribute("srcset")),
		];
		for (const item of items) {
			const candidate = mediaCandidate("image", "source", "dom", item.url, baseUrl);
			if (candidate !== undefined) {
				if (fallback !== undefined) copyDomMediaAttributes(fallback, candidate, primaryHeading, baseUrl);
				copyDomMediaAttributes(source, candidate, primaryHeading, baseUrl);
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
	return resolveHttpUrl(declared, finalUrl) ?? normalizeFinalUrl(finalUrl);
}

function linkHref(standardElements: readonly Element[], relation: string, baseUrl: string): EvidenceValue<string> | undefined {
	for (const link of standardElements) {
		if (link.localName !== "link") continue;
		const relations = link.getAttribute("rel")?.toLowerCase().split(/\s+/u) ?? [];
		if (!relations.includes(relation)) continue;
		const resolved = resolveHttpUrl(link.getAttribute("href"), baseUrl);
		if (resolved !== undefined) return { value: resolved, source: "dom" };
	}
	return undefined;
}

function evidenceUrl(value: string, baseUrl: string, source: PageEvidenceSource): EvidenceValue<string> | undefined {
	const resolved = resolveHttpUrl(value, baseUrl);
	return resolved === undefined ? undefined : { value: resolved, source };
}

function mediaCandidate(
	kind: MediaCandidate["kind"],
	role: MediaCandidate["role"],
	source: PageEvidenceSource,
	value: string | null,
	baseUrl: string,
): MediaCandidate | undefined {
	const url = resolveHttpUrl(value, baseUrl);
	return url === undefined ? undefined : { kind, role, source, url };
}

function copyDomMediaAttributes(
	node: Element,
	candidate: MediaCandidate,
	primaryHeading: Element | undefined,
	baseUrl: string,
): void {
	const mimeType = normalizeText(node.getAttribute("type"));
	const width = positiveDimension(node.getAttribute("width"));
	const height = positiveDimension(node.getAttribute("height"));
	const alt = normalizeText(node.getAttribute("alt"));
	if (mimeType !== undefined) candidate.mimeType = mimeType.toLowerCase();
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

function assignWidth(candidate: MediaCandidate, value: string): void {
	const width = positiveDimension(value);
	if (width !== undefined) candidate.width = width;
}

function assignHeight(candidate: MediaCandidate, value: string): void {
	const height = positiveDimension(value);
	if (height !== undefined) candidate.height = height;
}

export function parseImageSrcset(value: string | null): Array<{ url: string; width?: number }> {
	if (value === null) return [];
	return value
		.split(",")
		.flatMap((entry) => {
			const [url, descriptor] = entry.trim().split(/\s+/u);
			if (url === undefined || url.length === 0) return [];
			const widthMatch = /^(\d+)w$/u.exec(descriptor ?? "");
			const width = widthMatch?.[1] === undefined ? undefined : Number(widthMatch[1]);
			return [{ url, ...(width !== undefined && width > 0 ? { width } : {}) }];
		});
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

function normalizeFinalUrl(value: string): string {
	return resolveHttpUrl(value, value) ?? value;
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

function evidence<T>(value: T | undefined, source: PageEvidenceSource): EvidenceValue<T> | undefined {
	return value === undefined ? undefined : { value, source };
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

function uniqueEvidence(values: Array<EvidenceValue<string>>): Array<EvidenceValue<string>> {
	const seen = new Set<string>();
	return values.filter((item) => {
		const key = item.value.toLowerCase();
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
	title: EvidenceValue<string> | undefined,
	description: EvidenceValue<string> | undefined,
	visibleBody: VisibleBodyFacts,
	domPresence: DomPresence,
): boolean {
	if (title === undefined && description === undefined) return false;
	if (!domPresence.externalScript) return false;
	return visibleBody.textLength === 0 && !visibleBody.hasMedia;
}

function hasOpenGraphFacts(facts: OpenGraphFacts): boolean {
	return facts.title !== undefined
		|| facts.description !== undefined
		|| facts.type !== undefined
		|| facts.url !== undefined;
}

function hasTwitterFacts(facts: TwitterFacts): boolean {
	return facts.card !== undefined || facts.title !== undefined || facts.description !== undefined;
}

function hasJsonLdFacts(facts: JsonLdFacts): boolean {
	return facts.title !== undefined
		|| facts.description !== undefined
		|| facts.authors.length > 0
		|| facts.publishedAt !== undefined
		|| facts.modifiedAt !== undefined;
}
