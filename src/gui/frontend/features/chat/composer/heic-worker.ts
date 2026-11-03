import { decodeHeic } from "../../../../../harness/media/heic-decode.ts";
import type { HeicAttachmentResult } from "./heic-attachment.ts";

self.onmessage = async (event: MessageEvent<Uint8Array>) => {
	try {
		const image = await decodeHeic(event.data);
		if ("error" in image) {
			self.postMessage(image satisfies HeicAttachmentResult);
			return;
		}
		const canvas = new OffscreenCanvas(image.width, image.height);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Cannot create HEIC conversion canvas.");
		context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
		const blob = await canvas.convertToBlob({ type: "image/png" });
		self.postMessage({ blob, imageCount: image.imageCount } satisfies HeicAttachmentResult);
	} catch (error) {
		self.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies HeicAttachmentResult);
	}
};
