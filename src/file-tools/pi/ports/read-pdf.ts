import type { Canvas } from "@napi-rs/canvas";
import type {
	PDFDocumentLoadingTask,
	PDFDocumentProxy,
	PDFPageProxy,
	RenderTask,
} from "pdfjs-dist";
import type {
	PdfDocumentHandle,
	PdfDocumentOpenFailure,
	PdfDocumentSource,
	PdfMetadata,
	PdfPageRenderResult,
} from "../../read/ports.js";

const TARGET_SCALE = 2;
const MAX_PAGE_DIMENSION = 2_000;
const MAX_EMBEDDED_IMAGE_PIXELS = 16_000_000;
const MAX_CANVAS_BYTES = MAX_PAGE_DIMENSION * MAX_PAGE_DIMENSION * 4;

interface PdfRuntime {
	readonly pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
	readonly createCanvas: typeof import("@napi-rs/canvas").createCanvas;
}

export function createPdfDocumentSource(): PdfDocumentSource {
	return {
		async open(input) {
			if (isAborted(input.signal)) return abortedOpen();
			const runtime = await loadPdfRuntime();
			if (isAborted(input.signal)) return abortedOpen();

			const loadingTask = runtime.pdfjs.getDocument({
				data: new Uint8Array(input.bytes),
				cMapUrl: import.meta.resolve("pdfjs-dist/cmaps/"),
				cMapPacked: true,
				standardFontDataUrl: import.meta.resolve("pdfjs-dist/standard_fonts/"),
				wasmUrl: import.meta.resolve("pdfjs-dist/wasm/"),
				useWorkerFetch: false,
				maxImageSize: MAX_EMBEDDED_IMAGE_PIXELS,
				canvasMaxAreaInBytes: MAX_CANVAS_BYTES,
				stopAtErrors: true,
			});
			const removeAbortListener = cancelLoadingOnAbort(input.signal, loadingTask);
			try {
				const document = await loadingTask.promise;
				const [rawMetadata, pageLabels] = await Promise.all([
					document.getMetadata(),
					document.getPageLabels(),
				]);
				if (isAborted(input.signal)) {
					await destroyAfterFailure(loadingTask);
					return abortedOpen();
				}
				return {
					ok: true,
					value: new PdfJsDocumentHandle(
						loadingTask,
						document,
						normalizeMetadata(rawMetadata.info),
						pageLabels ?? undefined,
						runtime,
					),
				};
			} catch (error) {
				const failure = classifyOpenFailure(error, input.signal, runtime.pdfjs);
				await destroyAfterFailure(loadingTask);
				if (failure !== undefined) return failure;
				throw error;
			} finally {
				removeAbortListener();
			}
		},
	};
}

class PdfJsDocumentHandle implements PdfDocumentHandle {
	readonly pageCount: number;
	readonly metadata: PdfMetadata;
	readonly pageLabels: readonly string[] | undefined;
	private disposal: Promise<void> | undefined;

	constructor(
		private readonly loadingTask: PDFDocumentLoadingTask,
		private readonly document: PDFDocumentProxy,
		metadata: PdfMetadata,
		pageLabels: readonly string[] | undefined,
		private readonly runtime: PdfRuntime,
	) {
		this.pageCount = document.numPages;
		this.metadata = metadata;
		this.pageLabels = pageLabels;
	}

	async renderPage(input: {
		readonly pageNumber: number;
		readonly signal?: AbortSignal;
	}): Promise<PdfPageRenderResult> {
		if (this.disposal !== undefined) throw new Error("PDF document has been disposed.");
		if (isAborted(input.signal)) return abortedPage();

		let page: PDFPageProxy;
		try {
			page = await this.document.getPage(input.pageNumber);
		} catch (error) {
			if (isAborted(input.signal)) return abortedPage();
			return renderFailure(input.pageNumber, error);
		}

		let canvas: Canvas | undefined;
		try {
			const baseViewport = page.getViewport({ scale: 1 });
			if (!validDimension(baseViewport.width) || !validDimension(baseViewport.height)) {
				return invalidDimensions(input.pageNumber);
			}
			const scale = Math.min(
				TARGET_SCALE,
				MAX_PAGE_DIMENSION / baseViewport.width,
				MAX_PAGE_DIMENSION / baseViewport.height,
			);
			if (!validDimension(scale)) return invalidDimensions(input.pageNumber);
			const viewport = page.getViewport({ scale });
			if (!validDimension(viewport.width) || !validDimension(viewport.height)) {
				return invalidDimensions(input.pageNumber);
			}
			const width = Math.min(MAX_PAGE_DIMENSION, Math.max(1, Math.ceil(viewport.width)));
			const height = Math.min(MAX_PAGE_DIMENSION, Math.max(1, Math.ceil(viewport.height)));
			canvas = this.runtime.createCanvas(width, height);

			const renderTask = renderPdfPage(page, canvas, viewport, this.runtime.pdfjs.AnnotationMode.DISABLE);
			const removeAbortListener = cancelRenderOnAbort(input.signal, renderTask);
			try {
				await renderTask.promise;
			} catch (error) {
				if (isAborted(input.signal)) return abortedPage();
				return renderFailure(input.pageNumber, error);
			} finally {
				removeAbortListener();
			}
			if (isAborted(input.signal)) return abortedPage();
			const bytes = await canvas.encode("png");
			if (isAborted(input.signal)) return abortedPage();
			return {
				ok: true,
				value: {
					widthPoints: baseViewport.width,
					heightPoints: baseViewport.height,
					rotation: page.rotate,
					bytes,
					mimeType: "image/png",
				},
			};
		} finally {
			page.cleanup();
			if (canvas !== undefined) {
				canvas.width = 0;
				canvas.height = 0;
			}
		}
	}

	dispose(): Promise<void> {
		this.disposal ??= this.loadingTask.destroy();
		return this.disposal;
	}
}

function renderPdfPage(
	page: PDFPageProxy,
	canvas: Canvas,
	viewport: ReturnType<PDFPageProxy["getViewport"]>,
	annotationMode: number,
): RenderTask {
	return page.render({
		// PDF.js 使用同一 Node Canvas 实现，但其公开类型仍只声明浏览器 Canvas。
		// @ts-expect-error @napi-rs/canvas 是 PDF.js NodeCanvasFactory 的运行时画布。
		canvas,
		viewport,
		annotationMode,
	});
}

async function loadPdfRuntime(): Promise<PdfRuntime> {
	const [pdfjs, canvas] = await Promise.all([
		import("pdfjs-dist/legacy/build/pdf.mjs"),
		import("@napi-rs/canvas"),
	]);
	return { pdfjs, createCanvas: canvas.createCanvas };
}

function normalizeMetadata(info: object): PdfMetadata {
	const title = ownString(info, "Title");
	const author = ownString(info, "Author");
	const subject = ownString(info, "Subject");
	const keywords = ownString(info, "Keywords");
	const creator = ownString(info, "Creator");
	const producer = ownString(info, "Producer");
	const creationDate = ownString(info, "CreationDate");
	const modificationDate = ownString(info, "ModDate");
	const pdfVersion = ownString(info, "PDFFormatVersion");
	return {
		...(title === undefined ? {} : { title }),
		...(author === undefined ? {} : { author }),
		...(subject === undefined ? {} : { subject }),
		...(keywords === undefined ? {} : { keywords }),
		...(creator === undefined ? {} : { creator }),
		...(producer === undefined ? {} : { producer }),
		...(creationDate === undefined ? {} : { creationDate }),
		...(modificationDate === undefined ? {} : { modificationDate }),
		...(pdfVersion === undefined ? {} : { pdfVersion }),
	};
}

function ownString(value: object, key: string): string | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return typeof descriptor?.value === "string" && descriptor.value.length > 0
		? descriptor.value
		: undefined;
}

function classifyOpenFailure(
	error: unknown,
	signal: AbortSignal | undefined,
	pdfjs: PdfRuntime["pdfjs"],
): PdfDocumentOpenFailure | undefined {
	if (isAborted(signal) || error instanceof pdfjs.AbortException) return abortedOpen();
	if (error instanceof pdfjs.PasswordException) {
		return { ok: false, reason: "password-required", message: "Password-protected PDFs are not supported." };
	}
	if (error instanceof pdfjs.InvalidPDFException) {
		return { ok: false, reason: "invalid-document", message: errorMessage(error, "Invalid PDF document.") };
	}
	return undefined;
}

function cancelLoadingOnAbort(
	signal: AbortSignal | undefined,
	loadingTask: PDFDocumentLoadingTask,
): () => void {
	if (signal === undefined) return noop;
	const cancel = () => {
		loadingTask.destroy().catch(noop);
	};
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	return () => signal.removeEventListener("abort", cancel);
}

function cancelRenderOnAbort(signal: AbortSignal | undefined, renderTask: RenderTask): () => void {
	if (signal === undefined) return noop;
	const cancel = () => renderTask.cancel();
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	return () => signal.removeEventListener("abort", cancel);
}

async function destroyAfterFailure(loadingTask: PDFDocumentLoadingTask): Promise<void> {
	try {
		await loadingTask.destroy();
	} catch {
		// 清理失败不能覆盖原始的解析或取消结果。
	}
}

function validDimension(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

function abortedOpen(): PdfDocumentOpenFailure {
	return { ok: false, reason: "aborted", message: "Operation aborted." };
}

function abortedPage(): PdfPageRenderResult {
	return { ok: false, reason: "aborted", message: "Operation aborted." };
}

function invalidDimensions(pageNumber: number): PdfPageRenderResult {
	return {
		ok: false,
		reason: "invalid-dimensions",
		message: `PDF page ${pageNumber} has invalid dimensions.`,
	};
}

function renderFailure(pageNumber: number, error: unknown): PdfPageRenderResult {
	return {
		ok: false,
		reason: "render-failed",
		message: errorMessage(error, `PDF page ${pageNumber} could not be rendered.`),
	};
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function noop(): void {}
