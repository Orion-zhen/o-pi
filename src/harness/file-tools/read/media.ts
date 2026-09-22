import { fileTypeFromBuffer } from "file-type";

export type DetectedMediaKind = "image" | "pdf" | "audio" | "video" | "other";

export interface DetectedFileType {
	readonly ext: string;
	readonly mime: string;
	readonly kind: DetectedMediaKind;
}

export async function detectFileType(bytes: Uint8Array): Promise<DetectedFileType | undefined> {
	const detected = await fileTypeFromBuffer(bytes);
	if (detected === undefined) return undefined;
	// file-type 只匹配 GIF 前三个字节，普通文本必须继续走文本解码。
	if (detected.mime === "image/gif") {
		const signature = Buffer.from(bytes.subarray(0, 6)).toString("latin1");
		if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
	}
	return {
		ext: detected.ext,
		mime: detected.mime,
		kind: mediaKind(detected.mime),
	};
}

function mediaKind(mimeType: string): DetectedMediaKind {
	if (mimeType === "application/pdf") return "pdf";
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("audio/")) return "audio";
	if (mimeType.startsWith("video/")) return "video";
	return "other";
}
