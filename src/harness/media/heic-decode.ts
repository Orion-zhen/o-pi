import loadLibHeif from "libheif-js/libheif-wasm/libheif-bundle.mjs";
import type { HeicPixelsResult } from "./heic.ts";

const libheif = loadLibHeif();
// 解码预算独立于 SDK 的缩放策略，分配 RGBA 前限制内存用量。
const MAX_PIXELS = 64_000_000;

/** 在 Worker 内解码指定图片，保留容器中的旋转和镜像。索引不包含缩略图和辅助图。 */
export async function decodeHeic(bytes: Uint8Array, selection: "primary" | number = "primary"): Promise<HeicPixelsResult> {
	const decoder = new libheif.HeifDecoder();
	try {
		const images = decoder.decode(bytes);
		try {
			const primaryIndex = images.findIndex((image) => image.is_primary());
			if (primaryIndex < 0) return { error: "HEIC/HEIF primary image could not be read." };
			const image = images[selection === "primary" ? primaryIndex : selection];
			if (!image) return { error: "HEIC/HEIF image index is out of range." };
			const width = image.get_width();
			const height = image.get_height();
			if (width * height > MAX_PIXELS) return { error: `HEIC/HEIF image exceeds ${MAX_PIXELS} pixels.` };
			const pixels = { width, height, data: new Uint8ClampedArray(width * height * 4) };
			const decoded = await new Promise<boolean>((resolve) => image.display(pixels, (result) => resolve(result !== null)));
			return decoded ? { ...pixels, imageCount: images.length, primaryIndex } : { error: "HEIC/HEIF image could not be decoded." };
		} finally {
			for (const image of images) image.free();
		}
	} finally {
		// 上游 decoder 在首次解析前为 null，解析失败也可能持有上下文。
		if (decoder.decoder !== null) libheif.heif_context_free(decoder.decoder);
	}
}
