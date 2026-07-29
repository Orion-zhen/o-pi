import type { FileRef } from "../../filesystem/contracts/path.js";
import type { ReadStructureContext } from "./types.js";

export interface ReadStructureSource {
	context(input: {
		readonly file: FileRef;
		readonly content: string;
		readonly startLine: number;
		readonly endLine: number;
		readonly partial: boolean;
		readonly truncated: boolean;
		readonly signal?: AbortSignal;
	}): Promise<ReadStructureContext | undefined>;
}

export interface ProcessedInlineImage {
	readonly data: string;
	readonly mimeType: string;
	readonly hints: readonly string[];
}

export type InlineImageProcessResult =
	| { readonly ok: true; readonly value: ProcessedInlineImage }
	| { readonly ok: false; readonly reason: "conversion" | "resize"; readonly mimeType: string };

export interface InlineImageProcessor {
	process(input: {
		readonly bytes: Uint8Array;
		readonly mimeType: string;
		readonly path: string;
		readonly signal?: AbortSignal;
	}): Promise<InlineImageProcessResult>;
}
