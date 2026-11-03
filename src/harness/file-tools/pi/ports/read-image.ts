import { convertToPng } from "@earendil-works/pi-coding-agent";
import type { InlineImageProcessor } from "../../read/ports.ts";
import { convertHeicToPng } from "../../../media/heic-convert.ts";
import { heicHints, isHeicMimeType } from "../../../media/heic.ts";

export function createInlineImageProcessor(): InlineImageProcessor {
	return {
		async process(input) {
			if (isAborted(input.signal)) throw new Error("Operation aborted.");
			const normalized = await normalizeInlineImage(input.bytes, input.mimeType, input.signal);
			if (normalized === undefined) return { ok: false, reason: "conversion", mimeType: input.mimeType };
			if (isAborted(input.signal)) throw new Error("Operation aborted.");
			// 尺寸策略由 SDK 在工具结果进入历史前按模型及 autoResize 设置执行。
			return { ok: true, value: {
				data: normalized.bytes.toString("base64"), mimeType: normalized.mimeType, hints: normalized.hints,
			} };
		},
	};
}

async function normalizeInlineImage(
	bytes: Uint8Array,
	mimeType: string,
	signal: AbortSignal | undefined,
): Promise<{ bytes: Buffer; mimeType: string; hints: string[] } | undefined> {
	const buffer = Buffer.from(bytes);
	const normalizedMimeType = normalizeInlineImageMimeType(mimeType);
	if (normalizedMimeType !== undefined) return { bytes: buffer, mimeType: normalizedMimeType, hints: [] };

	if (isHeicMimeType(mimeType)) {
		const converted = await convertHeicToPng(bytes, signal);
		if ("error" in converted) return undefined;
		return { bytes: Buffer.from(converted.bytes), mimeType: "image/png", hints: heicHints(converted.imageCount) };
	}

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
