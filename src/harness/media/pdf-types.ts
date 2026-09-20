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
	readPageText(input: {
		readonly pageNumber: number;
		readonly signal?: AbortSignal;
	}): Promise<string>;
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
