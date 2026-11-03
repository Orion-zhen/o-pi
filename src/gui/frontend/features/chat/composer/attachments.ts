import type { ImageAttachment } from "@/features/sessions/session-views.ts";
import { isHeicMimeType } from "../../../../../harness/media/heic.ts";
import { convertHeicAttachment } from "./heic-attachment.ts";

// 跨组件挂载保持唯一，局域网 HTTP 不依赖 randomUUID 安全上下文。
let nextAttachmentId = 0;

export async function prepareAttachments(files: File[], signal: AbortSignal) {
	const images: ImageAttachment[] = [];
	const texts: string[] = [];
	for (const file of files) {
		signal.throwIfAborted();
		const mimeType = inlineMimeType(file.type);
		if (isHeicMimeType(file.type) || /\.hei[cf]$/i.test(file.name)) {
			const converted = await convertHeicAttachment(file, signal);
			if ("error" in converted) throw new Error(`${file.name}: ${converted.error}`);
			const data = await imageData(converted.blob, signal);
			images.push({ id: nextAttachmentId++, data, mimeType: "image/png", imageCount: converted.imageCount });
		} else if (mimeType) {
			images.push({ id: nextAttachmentId++, data: await imageData(file, signal), mimeType });
		} else {
			const bytes = new Uint8Array(await file.arrayBuffer());
			if (bytes.includes(0) || file.type === "application/pdf")
				throw new Error("二进制附件请通过 @路径 引用后端文件。");
			const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			texts.push(`<file path=${JSON.stringify(file.name)}>\n${content}\n</file>`);
		}
	}
	signal.throwIfAborted();
	return { images, texts };
}

function inlineMimeType(type: string): ImageAttachment["mimeType"] | undefined {
	switch (type) {
		case "image/png": case "image/jpeg": case "image/gif": case "image/webp": return type;
		default: return undefined;
	}
}

async function imageData(blob: Blob, signal: AbortSignal): Promise<string> {
	signal.throwIfAborted();
	const reader = new FileReader();
	const abort = () => reader.abort();
	signal.addEventListener("abort", abort, { once: true });
	try {
		const url = await new Promise<string>((resolve, reject) => {
			// readAsDataURL 的成功结果固定为字符串。
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = () => reject(reader.error);
			reader.onabort = () => reject(signal.reason);
			reader.readAsDataURL(blob);
		});
		return url.slice(url.indexOf(",") + 1);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
