import { convertToPng, formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { fileTypeFromBuffer } from "file-type";
import { fail } from "./errors.js";
import type { ToolOutcome } from "./types.js";

export type DetectedMediaKind = "image" | "audio" | "video" | "other";

export interface DetectedFileType {
	ext: string;
	mime: string;
	kind: DetectedMediaKind;
}

export interface ProcessedInlineImage {
	data: string;
	mimeType: string;
	hints: string[];
}

const INLINE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function detectFileType(bytes: Buffer): Promise<DetectedFileType | undefined> {
	const detected = await fileTypeFromBuffer(bytes);
	if (detected === undefined) return undefined;
	return {
		ext: detected.ext,
		mime: detected.mime,
		kind: mediaKind(detected.mime),
	};
}

export async function processInlineImage(bytes: Buffer, mimeType: string, relativePath: string): Promise<ToolOutcome<ProcessedInlineImage>> {
	const normalized = await normalizeInlineImage(bytes, mimeType);
	if (normalized === undefined) {
		return fail("BINARY_FILE_UNSUPPORTED", "Image cannot be converted to an inline model-supported format.", {
			path: relativePath,
			details: { mime_type: mimeType },
		});
	}

	const resized = await resizeImage(normalized.bytes, normalized.mimeType);
	if (resized === null) {
		return fail("BINARY_FILE_UNSUPPORTED", "Image cannot be resized below the inline model size limit.", {
			path: relativePath,
			details: { mime_type: normalized.mimeType },
		});
	}

	const hints = [...normalized.hints];
	const dimensionNote = formatDimensionNote(resized);
	if (dimensionNote !== undefined) hints.push(dimensionNote);
	return {
		data: resized.data,
		mimeType: resized.mimeType,
		hints,
	};
}

function mediaKind(mimeType: string): DetectedMediaKind {
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("audio/")) return "audio";
	if (mimeType.startsWith("video/")) return "video";
	return "other";
}

async function normalizeInlineImage(bytes: Buffer, mimeType: string): Promise<{ bytes: Buffer; mimeType: string; hints: string[] } | undefined> {
	const normalizedMimeType = normalizeInlineImageMimeType(mimeType);
	if (normalizedMimeType !== undefined) return { bytes, mimeType: normalizedMimeType, hints: [] };

	const converted = await convertToPng(bytes.toString("base64"), mimeType);
	if (converted === null) return undefined;
	return {
		bytes: Buffer.from(converted.data, "base64"),
		mimeType: converted.mimeType,
		hints: [`[Image converted from ${mimeType} to ${converted.mimeType}.]`],
	};
}

function normalizeInlineImageMimeType(mimeType: string): string | undefined {
	switch (mimeType) {
		case "image/png":
			return "image/png";
		case "image/jpeg":
		case "image/jpg":
			return "image/jpeg";
		case "image/gif":
			return "image/gif";
		case "image/webp":
			return "image/webp";
		default:
			return undefined;
	}
}
