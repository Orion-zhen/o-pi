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

export interface PdfMetadata {
	readonly title?: string;
	readonly author?: string;
	readonly subject?: string;
	readonly keywords?: string;
	readonly creator?: string;
	readonly producer?: string;
	readonly creationDate?: string;
	readonly modificationDate?: string;
	readonly pdfVersion?: string;
}

export interface RenderedPdfPage {
	readonly widthPoints: number;
	readonly heightPoints: number;
	readonly rotation: number;
	readonly bytes: Uint8Array;
	readonly mimeType: "image/png";
}

export interface PdfPageRenderFailure {
	readonly ok: false;
	readonly reason: "aborted" | "invalid-dimensions" | "render-failed";
	readonly message: string;
}

export type PdfPageRenderResult =
	| { readonly ok: true; readonly value: RenderedPdfPage }
	| PdfPageRenderFailure;

export interface PdfDocumentHandle {
	readonly pageCount: number;
	readonly metadata: PdfMetadata;
	readonly pageLabels: readonly string[] | undefined;
	renderPage(input: {
		readonly pageNumber: number;
		readonly signal?: AbortSignal;
	}): Promise<PdfPageRenderResult>;
	dispose(): Promise<void>;
}

export interface PdfDocumentOpenFailure {
	readonly ok: false;
	readonly reason: "aborted" | "invalid-document" | "password-required";
	readonly message: string;
}

export type PdfDocumentOpenResult =
	| { readonly ok: true; readonly value: PdfDocumentHandle }
	| PdfDocumentOpenFailure;

export interface PdfDocumentSource {
	open(input: {
		readonly bytes: Uint8Array;
		readonly signal?: AbortSignal;
	}): Promise<PdfDocumentOpenResult>;
}
