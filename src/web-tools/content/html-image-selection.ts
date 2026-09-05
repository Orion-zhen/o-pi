export interface ImageCandidate {
	role: "primary" | "thumbnail" | "poster" | "content" | "source";
	source: "dom" | "open_graph" | "twitter" | "json_ld";
	url: string;
	secureUrl?: string;
	width?: number;
	height?: number;
	alt?: string;
	titleDistance?: number;
	presentation?: boolean;
	hidden?: boolean;
	likelyAvatar?: boolean;
	likelyDecorative?: boolean;
}

const MIN_PRIMARY_SCORE = 2_800;
const DECORATIVE_PATTERN = /(?:^|[^a-z])(logo|icon|sprite|emoji|badge|decorative|decoration)(?:[^a-z]|$)/iu;

/** 合并同图声明，按原有规则选择至多一张主图。 */
export function selectPrimaryImage(candidates: ImageCandidate[], selectedUrls: ReadonlySet<string>): ImageCandidate | undefined {
	let best: { candidate: ImageCandidate; score: number } | undefined;
	for (const candidate of deduplicateCandidates(candidates)) {
		const score = imageScore(candidate, selectedUrls);
		if (score < MIN_PRIMARY_SCORE || (best !== undefined && score <= best.score)) continue;
		best = { candidate, score };
	}
	return best?.candidate;
}

/** 收集最终正文保留的图片和视频封面 URL。 */
export function selectedImageUrls(root: Element, baseUrl: string): Set<string> {
	const urls = new Set<string>();
	for (const element of root.querySelectorAll("img, picture source, video[poster]")) {
		if (element.localName === "video") {
			addUrl(urls, element.getAttribute("poster"), baseUrl);
			continue;
		}
		addUrl(urls, element.getAttribute("src"), baseUrl);
		for (const item of parseImageSrcset(element.getAttribute("srcset"))) addUrl(urls, item.url, baseUrl);
	}
	return urls;
}

export function parseImageSrcset(value: string | null): Array<{ url: string; width?: number }> {
	if (value === null) return [];
	return value.split(",").flatMap((entry) => {
		const [url, descriptor] = entry.trim().split(/\s+/u);
		if (url === undefined || url.length === 0) return [];
		const widthMatch = /^(\d+)w$/u.exec(descriptor ?? "");
		const width = widthMatch?.[1] === undefined ? undefined : Number(widthMatch[1]);
		return [{ url, ...(width !== undefined && width > 0 ? { width } : {}) }];
	});
}

function deduplicateCandidates(candidates: ImageCandidate[]): ImageCandidate[] {
	const deduplicated = new Map<string, ImageCandidate>();
	for (const candidate of candidates) {
		const url = candidate.secureUrl ?? candidate.url;
		const key = `${url}\0${candidate.width ?? ""}x${candidate.height ?? ""}`;
		const existing = deduplicated.get(key);
		if (existing === undefined) {
			deduplicated.set(key, { ...candidate });
			continue;
		}
		const preferred = intrinsicScore(candidate) > intrinsicScore(existing) ? candidate : existing;
		const alt = preferred.alt ?? existing.alt;
		const titleDistance = minDefined(preferred.titleDistance, existing.titleDistance);
		deduplicated.set(key, {
			...preferred,
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

function imageScore(candidate: ImageCandidate, selectedUrls: ReadonlySet<string>): number {
	if (candidate.hidden === true || candidate.presentation === true) return Number.NEGATIVE_INFINITY;
	let score = intrinsicScore(candidate);
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
	if (candidate.likelyDecorative === true || DECORATIVE_PATTERN.test(`${candidate.alt ?? ""} ${candidate.url}`)) score -= 9_000;
	return score;
}

function intrinsicScore(candidate: ImageCandidate): number {
	const role = { poster: 6_500, primary: 4_000, thumbnail: 3_500, content: 2_500, source: 1_000 }[candidate.role];
	const source = { open_graph: 1_500, json_ld: 1_300, twitter: 1_200, dom: 0 }[candidate.source];
	return role + source;
}

function addUrl(output: Set<string>, value: string | null, baseUrl: string): void {
	if (value === null || value.trim().length === 0) return;
	try {
		const url = new URL(value, baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return;
		url.hash = "";
		output.add(url.toString());
	} catch {
		// 忽略页面中无法解析的图片地址。
	}
}

function minDefined(left: number | undefined, right: number | undefined): number | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return Math.min(left, right);
}
