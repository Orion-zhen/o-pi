export const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function mimeFromContentType(value: string | null): string {
	return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function supportedImageMimeFromHeader(value: string | null): string | undefined {
	const mime = mimeFromContentType(value);
	return SUPPORTED_IMAGE_TYPES.has(mime) ? mime : undefined;
}
