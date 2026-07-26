import { fileTypeFromBuffer } from "file-type";

export type DetectedMediaKind = "image" | "audio" | "video" | "other";

export interface DetectedFileType {
	readonly ext: string;
	readonly mime: string;
	readonly kind: DetectedMediaKind;
}

export async function detectFileType(bytes: Uint8Array): Promise<DetectedFileType | undefined> {
	const detected = await fileTypeFromBuffer(bytes);
	if (detected === undefined) return undefined;
	return {
		ext: detected.ext,
		mime: detected.mime,
		kind: mediaKind(detected.mime),
	};
}

function mediaKind(mimeType: string): DetectedMediaKind {
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("audio/")) return "audio";
	if (mimeType.startsWith("video/")) return "video";
	return "other";
}
