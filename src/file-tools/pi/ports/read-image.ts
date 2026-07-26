import { convertToPng, formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import type { InlineImageProcessor } from "../../read/ports.js";

export function createInlineImageProcessor(): InlineImageProcessor {
	return {
		async process(input) {
			if (isAborted(input.signal)) throw new Error("Operation aborted.");
			const normalized = await normalizeInlineImage(input.bytes, input.mimeType);
			if (normalized === undefined) return { ok: false, reason: "conversion", mimeType: input.mimeType };
			if (isAborted(input.signal)) throw new Error("Operation aborted.");
			const resized = await resizeImage(normalized.bytes, normalized.mimeType);
			if (resized === null) return { ok: false, reason: "resize", mimeType: normalized.mimeType };
			if (isAborted(input.signal)) throw new Error("Operation aborted.");
			const hints = [...normalized.hints];
			const dimensionNote = formatDimensionNote(resized);
			if (dimensionNote !== undefined) hints.push(dimensionNote);
			return { ok: true, value: { data: resized.data, mimeType: resized.mimeType, hints } };
		},
	};
}

async function normalizeInlineImage(
	bytes: Uint8Array,
	mimeType: string,
): Promise<{ bytes: Buffer; mimeType: string; hints: string[] } | undefined> {
	const buffer = Buffer.from(bytes);
	const normalizedMimeType = normalizeInlineImageMimeType(mimeType);
	if (normalizedMimeType !== undefined) return { bytes: buffer, mimeType: normalizedMimeType, hints: [] };

	const converted = await convertToPng(buffer.toString("base64"), mimeType);
	if (converted === null) return undefined;
	return {
		bytes: Buffer.from(converted.data, "base64"),
		mimeType: converted.mimeType,
		hints: [`[Image converted from ${mimeType} to ${converted.mimeType}.]`],
	};
}

function normalizeInlineImageMimeType(mimeType: string): string | undefined {
	switch (mimeType) {
		case "image/png": return "image/png";
		case "image/jpeg":
		case "image/jpg": return "image/jpeg";
		case "image/gif": return "image/gif";
		case "image/webp": return "image/webp";
		default: return undefined;
	}
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}
