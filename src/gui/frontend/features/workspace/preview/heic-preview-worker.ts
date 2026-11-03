import { decodeHeic } from "../../../../../harness/media/heic-decode.ts";
import type { HeicPixelsResult } from "../../../../../harness/media/heic.ts";

export type HeicPreviewRequest = { kind: "open"; url: string } | { kind: "select"; index: number };

// 查看器只在打开成功后发送切图请求，原文件保留到 Worker 终止。
let bytes: Uint8Array;
self.onmessage = async (event: MessageEvent<HeicPreviewRequest>) => {
	const request = event.data;
	try {
		if (request.kind === "open") {
			const response = await fetch(request.url);
			if (!response.ok) throw new Error(`HEIC/HEIF file request failed (${response.status}).`);
			bytes = new Uint8Array(await response.arrayBuffer());
		}
		const result = await decodeHeic(bytes, request.kind === "open" ? "primary" : request.index);
		self.postMessage(result, { transfer: "error" in result ? [] : [result.data.buffer] });
	} catch (error) {
		self.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies HeicPixelsResult);
	}
};
