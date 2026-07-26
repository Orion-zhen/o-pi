import type { ContentVersion } from "../../filesystem/contracts/content.js";
import type { DirectoryRef, FileRef, TargetRef } from "../../filesystem/contracts/path.js";
import type { ReadGraphContext, ReadStructureContext } from "./types.js";

export interface MissingPathSource {
	suggest(input: {
		readonly root: DirectoryRef;
		readonly target: TargetRef;
		readonly query: string;
		readonly limit: number;
		readonly signal?: AbortSignal;
	}): Promise<readonly string[]>;
}

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

export interface ReadGraphContextSource {
	context(input: {
		readonly file: FileRef;
		readonly version: ContentVersion;
		readonly startLine: number;
		readonly endLine: number;
		readonly partial: boolean;
		readonly truncated: boolean;
		readonly signal?: AbortSignal;
	}): Promise<{ readonly context: ReadGraphContext; readonly rendered: string } | undefined>;
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
