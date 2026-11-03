export type HeicPngResult = { bytes: Uint8Array<ArrayBuffer>; imageCount: number } | { error: string };

export interface HeicPixels {
	width: number;
	height: number;
	data: Uint8ClampedArray<ArrayBuffer>;
	imageCount: number;
	primaryIndex: number;
}
export type HeicPixelsResult = HeicPixels | { error: string };

export function isHeicMimeType(mimeType: string): boolean {
	return /^image\/hei[cf](?:-sequence)?$/.test(mimeType);
}

export function heicHints(imageCount: number): string[] {
	return imageCount > 1 ? [`[Image: primary only, ${imageCount} images total.]`] : [];
}
