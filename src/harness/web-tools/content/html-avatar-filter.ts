const PROFILE_ROUTE_ROOTS = new Set([
	"author",
	"authors",
	"member",
	"members",
	"people",
	"profile",
	"profiles",
	"u",
	"user",
	"users",
]);
const EXPLICIT_AVATAR_ROLES = new Set(["avatar", "headshot", "u-photo", "userpic"]);
const AVATAR_CONTAINER_ROLES = new Set(["container", "image", "img", "photo", "picture", "wrapper"]);
const IDENTITY_TOKENS = new Set(["account", "author", "member", "profile", "user"]);
const IMAGE_TOKENS = new Set(["avatar", "headshot", "image", "photo", "picture", "portrait", "userpic"]);
const ACCESSIBLE_AVATAR_TOKENS = new Set(["avatar", "headshot", "userpic", "头像", "頭像", "アバター"]);
const MAX_PORTRAIT_EDGE = 512;
const MAX_PROFILE_LINK_SCOPE_DEPTH = 3;

/** Remove avatar media before HTML is converted to Markdown. */
export function removeAvatarImages(root: Document | Element, baseUrl?: string): void {
	for (const image of [...root.querySelectorAll("img")]) {
		if (!isAvatarImage(image, baseUrl)) continue;
		const imageLink = image.closest("a[href]");
		const removeImageLink = imageLink !== null && hasOnlyImageContent(imageLink, image);
		const picture = image.closest("picture");
		if (picture !== null && picture.querySelectorAll("img").length === 1) picture.remove();
		else image.remove();
		if (removeImageLink) imageLink.remove();
	}
}

/**
 * Classify avatars from independent DOM signals. Image URL text never
 * participates, and accessible labels cannot trigger removal by themselves.
 */
export function isAvatarImage(image: Element, baseUrl?: string): boolean {
	if (image.tagName.toLowerCase() !== "img") return false;
	const link = image.closest("a[href]");
	const imageOnlyLink = link !== null && hasOnlyImageContent(link, image);
	const structuredAuthor = hasStructuredAuthorContext(image);
	const profileLink = link !== null && isProfileDestination(link.getAttribute("href"), baseUrl);
	const pairedAuthorLink = link !== null && hasNearbyTextLinkToSameTarget(link, baseUrl);
	const portraitGeometry = hasCompactPortraitGeometry(image);
	const avatarRole = hasAvatarRoleAttribute(image);
	const accessibleAvatar = hasAccessibleAvatarLabel(image);

	if (structuredAuthor && (imageOnlyLink || avatarRole || portraitGeometry)) return true;
	if (profileLink && imageOnlyLink && (pairedAuthorLink || portraitGeometry || avatarRole || accessibleAvatar)) return true;
	return avatarRole && (link === null || imageOnlyLink);
}

function hasStructuredAuthorContext(image: Element): boolean {
	const imageClasses = attributeTokens(image.getAttribute("class"));
	let current: Element | null = image;
	while (current !== null) {
		const rel = attributeTokens(current.getAttribute("rel"));
		if (rel.has("author") || rel.has("me")) return true;
		const itemProperties = attributeTokens(current.getAttribute("itemprop"));
		if (itemProperties.has("author")) return true;
		for (const itemType of whitespaceTokens(current.getAttribute("itemtype"))) {
			if (schemaType(itemType) === "person") return true;
		}
		const classes = attributeTokens(current.getAttribute("class"));
		if (classes.has("h-card") && imageClasses.has("u-photo")) return true;
		current = current.parentElement;
	}
	return false;
}

function hasAvatarRoleAttribute(image: Element): boolean {
	const nodes = [image, image.closest("picture"), image.parentElement]
		.filter((node): node is Element => node !== null);
	for (const node of nodes) {
		const tokens = new Set<string>();
		const explicitRoles = new Set<string>();
		for (const name of ["id", "class", "name", "slot", "part", "data-testid", "data-role"]) {
			const value = node.getAttribute(name);
			for (const token of attributeTokens(value)) tokens.add(token);
			for (const role of whitespaceTokens(value)) explicitRoles.add(role.normalize("NFKC").toLowerCase());
		}
		if ([...explicitRoles].some(isExplicitAvatarRole)) return true;
		if (tokens.has("userpic") || tokens.has("headshot")) return true;
		const identity = [...tokens].some((token) => IDENTITY_TOKENS.has(token));
		const imageRole = [...tokens].some((token) => IMAGE_TOKENS.has(token));
		if (identity && imageRole) return true;
	}
	return false;
}

function isExplicitAvatarRole(value: string): boolean {
	if (EXPLICIT_AVATAR_ROLES.has(value)) return true;
	const tokens = [...attributeTokens(value)];
	const first = tokens[0];
	const last = tokens.at(-1);
	if (last === "avatar" || last === "headshot" || last === "userpic") return true;
	return first === "avatar" && tokens[1] !== undefined && AVATAR_CONTAINER_ROLES.has(tokens[1]);
}

function hasAccessibleAvatarLabel(image: Element): boolean {
	const tokens = new Set([
		...attributeTokens(image.getAttribute("alt")),
		...attributeTokens(image.getAttribute("aria-label")),
	]);
	return [...tokens].some((token) => ACCESSIBLE_AVATAR_TOKENS.has(token));
}

function hasOnlyImageContent(link: Element, image: Element): boolean {
	const images = [...link.querySelectorAll("img")];
	if (images.length !== 1 || images[0] !== image) return false;
	if (normalizedText(link.textContent).length > 0) return false;
	return link.querySelector("video, audio, svg, canvas") === null;
}

function hasNearbyTextLinkToSameTarget(imageLink: Element, baseUrl: string | undefined): boolean {
	const target = normalizedLinkTarget(imageLink.getAttribute("href"), baseUrl);
	if (target === undefined) return false;
	let scope = imageLink.parentElement;
	for (let depth = 0; scope !== null && depth < MAX_PROFILE_LINK_SCOPE_DEPTH; depth += 1) {
		for (const candidate of scope.querySelectorAll("a[href]")) {
			if (candidate === imageLink || candidate.querySelector("img, picture, video, svg") !== null) continue;
			if (normalizedText(candidate.textContent).length === 0) continue;
			if (normalizedLinkTarget(candidate.getAttribute("href"), baseUrl) === target) return true;
		}
		if (scope.matches("article, main, body")) break;
		scope = scope.parentElement;
	}
	return false;
}

function isProfileDestination(value: string | null, baseUrl: string | undefined): boolean {
	const url = parseUrl(value, baseUrl);
	if (url === undefined) return false;
	const segments = url.pathname
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((segment) => safeDecode(segment).normalize("NFKC").toLowerCase());
	const first = segments[0];
	if (first === undefined) return false;
	if (first.startsWith("@") && first.length > 1) return true;
	if (!PROFILE_ROUTE_ROOTS.has(first)) return false;
	return segments.length >= 2 || url.searchParams.has("id") || url.searchParams.has("user");
}

function normalizedLinkTarget(value: string | null, baseUrl: string | undefined): string | undefined {
	const url = parseUrl(value, baseUrl);
	if (url === undefined) return undefined;
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
	return url.toString();
}

function parseUrl(value: string | null, baseUrl: string | undefined): URL | undefined {
	if (value === null || value.trim().length === 0) return undefined;
	try {
		return baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);
	} catch {
		return undefined;
	}
}

function hasCompactPortraitGeometry(image: Element): boolean {
	const width = dimension(image, "width");
	const height = dimension(image, "height");
	if (width === undefined || height === undefined) return false;
	const largest = Math.max(width, height);
	const ratio = width / height;
	return largest <= MAX_PORTRAIT_EDGE && ratio >= 0.7 && ratio <= 1.43;
}

function dimension(image: Element, name: "width" | "height"): number | undefined {
	const attribute = positiveNumber(image.getAttribute(name));
	if (attribute !== undefined) return attribute;
	const style = image.getAttribute("style");
	if (style === null) return undefined;
	const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*(\\d+(?:\\.\\d+)?)px(?:\\s*!important)?\\s*(?:;|$)`, "iu").exec(style);
	return positiveNumber(match?.[1] ?? null);
}

function positiveNumber(value: string | null): number | undefined {
	if (value === null || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function attributeTokens(value: string | null): Set<string> {
	return new Set(
		(value ?? "")
			.normalize("NFKC")
			.replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((token) => token.length > 0),
	);
}

function whitespaceTokens(value: string | null): string[] {
	return (value ?? "").trim().split(/\s+/u).filter((token) => token.length > 0);
}

function schemaType(value: string): string {
	return value.toLowerCase().split(/[/:#]/u).filter((part) => part.length > 0).at(-1) ?? "";
}

function normalizedText(value: string | null): string {
	return (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
