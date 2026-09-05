import type { ByteContent, ContentVersion, TextContent, TextSlice } from "../../filesystem/contracts/content.js";
import type { FileRef } from "../../filesystem/contracts/path.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { fail, mapFsError, type ToolOutcome } from "../shared/result.js";
import { detectFileType } from "./media.js";
import { suggestPaths } from "./path-suggestions.js";
import type { InlineImageProcessor, PdfDocumentHandle, PdfDocumentSource, ReadStructureSource } from "./ports.js";
import { formatReadStructureContext } from "./presenter.js";
import { parseReadRange, type ReadRange } from "./range.js";
import type { ReadFileSuccess, ReadOutputFormat, ReadParams, ReadPdfMetadata, ReadPdfPage, ReadPdfSuccess, ReadStructureContext } from "./types.js";

const PATH_SUGGESTION_ENTRY_LIMIT = 10_000;

export interface ReadObservationStore {
	remember(file: FileRef, version: ContentVersion): void;
}

export interface ReadCommandContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly observation: ReadObservationStore;
	readonly limits: {
		readonly bytes: number;
		readonly fileBytes: number;
		readonly lines: number;
		readonly pdfPages: number;
		readonly suggestions: number;
	};
	readonly structure?: ReadStructureSource;
	readonly image: InlineImageProcessor;
	readonly pdf: PdfDocumentSource;
	readonly supportedOutputFormats?: readonly ReadOutputFormat[];
}

/** Reads one guarded workspace file and composes only read-owned optional ports. */
export async function readFile(
	params: ReadParams,
	context: ReadCommandContext,
): Promise<ToolOutcome<ReadFileSuccess>> {
	const ranges = parseRanges(params);
	if ("status" in ranges) return ranges;

	const resolved = await context.filesystem.paths.resolveExisting(
		params.path,
		{ expected: "file", followFinalSymlink: true },
	);
	if (!resolved.ok) {
		if (resolved.error.code !== "not-found") return mapFsError(resolved.error, { notFound: "file" });
		const suggestions = await missingPathSuggestions(params.path, context);
		if (isAborted(context.operation)) return aborted(params.path);
		return mapFsError(resolved.error, {
			notFound: "file",
			message: "File does not exist.",
			...(suggestions.length === 0 ? {} : { next: `Related paths: ${suggestions.join(", ")}` }),
		});
	}
	const file = resolved.value;

	const visibility = await context.filesystem.visibility.evaluate(file, "explicit-read");
	if (!visibility.ok) return mapFsError(visibility.error);
	const ignoreSource = visibility.value.ignored ? shortIgnoreSource(visibility.value.source) : undefined;

	const loaded = await context.filesystem.content.readBytes(
		file,
		{ maxBytes: context.limits.fileBytes },
	);
	if (!loaded.ok) return mapFsError(loaded.error, { notFound: "file" });
	if (isAborted(context.operation)) return aborted(file.displayPath);

	const detected = await detectFileType(loaded.value.bytes);
	if (isAborted(context.operation)) return aborted(file.displayPath);
	if (detected?.kind === "image") {
		if (context.supportedOutputFormats?.includes("image") === false) {
			return fail("API_NOT_SUPPORTED", "API does not support image format.", { path: file.displayPath });
		}
		if (ranges.lines !== undefined || ranges.pages !== undefined) {
			return fail("INVALID_OPERATION", "Range parameters do not apply to image files.", { path: file.displayPath });
		}
		const image = await processImage(context.image, context.operation, {
			bytes: loaded.value.bytes,
			mimeType: detected.mime,
			path: file.displayPath,
			...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
		});
		if (image === undefined || isAborted(context.operation)) return aborted(file.displayPath);
		if (!image.ok) {
			const resize = image.reason === "resize";
			return fail("BINARY_FILE_UNSUPPORTED", resize
				? "Image cannot be resized below the inline model size limit."
				: "Image cannot be converted to an inline model-supported format.", {
				path: file.displayPath,
				details: { mime_type: image.mimeType },
			});
		}
		context.observation.remember(file, loaded.value);
		const processed = image.value;
		const result: ReadFileSuccess = {
			path: file.displayPath,
			media_type: "image",
			mime_type: detected.mime,
			content: [`Read image file [${processed.mimeType}]`, ...processed.hints].join("\n"),
			size_bytes: loaded.value.sizeBytes,
			version: loaded.value.hash,
			image: { data: processed.data, mime_type: processed.mimeType },
			...(processed.hints.length === 0 ? {} : { hints: [...processed.hints] }),
		};
		applyIgnore(result, ignoreSource);
		return result;
	}
	if (detected?.kind === "pdf") {
		if (context.supportedOutputFormats?.includes("image") === false) {
			return fail("API_NOT_SUPPORTED", "API does not support image format.", { path: file.displayPath });
		}
		if (ranges.lines !== undefined) {
			return fail("INVALID_OPERATION", "Line ranges apply only to text files.", { path: file.displayPath });
		}
		const pdf = await readPdf(file.displayPath, loaded.value, ranges.pages, context);
		if ("status" in pdf) return pdf;
		context.observation.remember(file, loaded.value);
		applyIgnore(pdf, ignoreSource);
		return pdf;
	}
	if (detected !== undefined) {
		if (ranges.lines !== undefined) {
			return fail("INVALID_OPERATION", "Line ranges apply only to text files.", { path: file.displayPath });
		}
		if (ranges.pages !== undefined) {
			return fail("INVALID_OPERATION", "Page ranges apply only to PDF files.", { path: file.displayPath });
		}
		return fail("BINARY_FILE_UNSUPPORTED", `${detected.kind} files are not supported by read.`, {
			path: file.displayPath,
			details: { mime_type: detected.mime, extension: detected.ext },
		});
	}
	if (ranges.pages !== undefined) {
		return fail("INVALID_OPERATION", "Page ranges apply only to PDF files.", { path: file.displayPath });
	}

	const decoded = context.filesystem.content.decodeText(loaded.value, file.displayPath);
	if (!decoded.ok) return mapFsError(decoded.error, { notFound: "file" });
	context.observation.remember(file, decoded.value);

	const initialSlice = context.filesystem.content.sliceText(decoded.value, sliceOptions(ranges.lines, params.path, context));
	if (!initialSlice.ok) return mapFsError(initialSlice.error, { notFound: "file" });
	let sliced = initialSlice.value;
	const partial = ranges.lines !== undefined;
	const needsContext = partial || sliced.truncated || sliced.continuation !== undefined;
	let structure: ReadStructureContext | undefined;
	if (needsContext) {
		structure = await safeStructureContext(context.structure, file, decoded.value.text, sliced, partial, context.operation);
		if (isAborted(context.operation)) return aborted(file.displayPath);
		const budgeted = reserveContextBudget(ranges.lines, params.path, context, decoded.value, sliced, structure);
		sliced = budgeted.slice;
		structure = budgeted.structure;
	}

	const result: ReadFileSuccess = {
		path: file.displayPath,
		content: sliced.content,
		start_line: sliced.startLine,
		end_line: sliced.endLine,
		total_lines: decoded.value.totalLines,
		size_bytes: decoded.value.sizeBytes,
		version: decoded.value.hash,
		encoding: "utf-8",
		newline: decoded.value.newline,
		truncated: sliced.truncated,
		...(sliced.continuation === undefined ? {} : { continuation: { start_line: sliced.continuation.startLine } }),
		bom: decoded.value.hasBom,
		...(structure === undefined ? {} : { lsp: structure }),
	};
	applyIgnore(result, ignoreSource);
	return result;
}

async function readPdf(
	path: string,
	content: ByteContent,
	range: ReadRange | undefined,
	context: ReadCommandContext,
): Promise<ToolOutcome<ReadPdfSuccess>> {
	const opened = await context.pdf.open({
		bytes: content.bytes,
		...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
	});
	if (!opened.ok) {
		if (opened.reason === "aborted" || isAborted(context.operation)) return aborted(path);
		return fail("BINARY_FILE_UNSUPPORTED", opened.message, {
			path,
			details: { mime_type: "application/pdf", stage: "parse", reason: opened.reason },
		});
	}

	const document = opened.value;
	try {
		if (isAborted(context.operation)) return aborted(path);
		const selected = selectPdfPages(range, document.pageCount, context.limits.pdfPages, path);
		if ("status" in selected) return selected;

		const pages: ReadPdfPage[] = [];
		for (let pageNumber = selected.start; pageNumber <= selected.end; pageNumber += 1) {
			if (isAborted(context.operation)) return aborted(path);
			const rendered = await document.renderPage({
				pageNumber,
				...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
			});
			if (!rendered.ok) {
				if (rendered.reason === "aborted" || isAborted(context.operation)) return aborted(path);
				return fail("BINARY_FILE_UNSUPPORTED", rendered.message, {
					path,
					details: {
						mime_type: "application/pdf",
						stage: "render",
						page: pageNumber,
						reason: rendered.reason,
					},
				});
			}

			const processed = await processImage(context.image, context.operation, {
				bytes: rendered.value.bytes,
				mimeType: rendered.value.mimeType,
				path: `${path}#page=${pageNumber}`,
				...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
			});
			if (processed === undefined || isAborted(context.operation)) return aborted(path);
			if (!processed.ok) {
				const resize = processed.reason === "resize";
				return fail("BINARY_FILE_UNSUPPORTED", resize
					? `PDF page ${pageNumber} cannot be resized below the inline model size limit.`
					: `PDF page ${pageNumber} cannot be converted to an inline model-supported format.`, {
					path,
					details: {
						mime_type: processed.mimeType,
						stage: "image-process",
						page: pageNumber,
					},
				});
			}

			const page = rendered.value;
			const label = document.pageLabels?.[pageNumber - 1];
			pages.push({
				number: pageNumber,
				...(label === undefined ? {} : { label }),
				width_points: page.widthPoints,
				height_points: page.heightPoints,
				rotation: page.rotation,
				image: { data: processed.value.data, mime_type: processed.value.mimeType },
				...(processed.value.hints.length === 0 ? {} : { hints: [...processed.value.hints] }),
			});
		}

		return {
			path,
			media_type: "pdf",
			mime_type: "application/pdf",
			size_bytes: content.sizeBytes,
			version: content.hash,
			start_page: selected.start,
			end_page: selected.end,
			total_pages: document.pageCount,
			truncated: selected.truncated,
			...(selected.continuation === undefined ? {} : { continuation: { start_page: selected.continuation } }),
			metadata: readPdfMetadata(document),
			pages,
		};
	} finally {
		await safeDisposePdf(document);
	}
}

function selectPdfPages(
	range: ReadRange | undefined,
	totalPages: number,
	limit: number,
	path: string,
): { start: number; end: number; truncated: boolean; continuation?: number } | ToolOutcome<never> {
	const start = range?.start ?? 1;
	if (start > totalPages) {
		return fail("INVALID_PATH", `PDF page ${start} is outside 1-${totalPages}.`, {
			path,
			details: { start_page: start, total_pages: totalPages },
		});
	}
	const requestedEnd = Math.min(range?.end ?? totalPages, totalPages);
	const end = Math.min(requestedEnd, start + limit - 1);
	const truncated = end < requestedEnd;
	return {
		start,
		end,
		truncated,
		...(truncated ? { continuation: end + 1 } : {}),
	};
}

function readPdfMetadata(document: PdfDocumentHandle): ReadPdfMetadata {
	const metadata = document.metadata;
	return {
		...(metadata.title === undefined ? {} : { title: metadata.title }),
		...(metadata.author === undefined ? {} : { author: metadata.author }),
		...(metadata.subject === undefined ? {} : { subject: metadata.subject }),
		...(metadata.keywords === undefined ? {} : { keywords: metadata.keywords }),
		...(metadata.creator === undefined ? {} : { creator: metadata.creator }),
		...(metadata.producer === undefined ? {} : { producer: metadata.producer }),
		...(metadata.creationDate === undefined ? {} : { creation_date: metadata.creationDate }),
		...(metadata.modificationDate === undefined ? {} : { modification_date: metadata.modificationDate }),
		...(metadata.pdfVersion === undefined ? {} : { pdf_version: metadata.pdfVersion }),
	};
}

async function safeDisposePdf(document: PdfDocumentHandle): Promise<void> {
	try {
		await document.dispose();
	} catch {
		// 清理失败不能覆盖解析、渲染或图片处理的原始结果。
	}
}

async function missingPathSuggestions(input: string, context: ReadCommandContext): Promise<string[]> {
	const target = await context.filesystem.paths.resolveTarget(input);
	if (!target.ok || target.value.workspacePath === undefined || isAborted(context.operation)) return [];
	const suggestions = await suggestPaths(
		context.filesystem.discovery,
		context.filesystem.root,
		target.value.workspacePath,
		{ limit: context.limits.suggestions, maxEntries: PATH_SUGGESTION_ENTRY_LIMIT },
	);
	if (!suggestions.ok) return [];
	return uniquePaths(suggestions.value.map((candidate) => candidate.ref.workspacePath ?? candidate.ref.displayPath), context.limits.suggestions);
}

function reserveContextBudget(
	range: ReadRange | undefined,
	path: string,
	context: ReadCommandContext,
	content: TextContent,
	initialSlice: TextSlice,
	structure: ReadStructureContext | undefined,
): { slice: TextSlice; structure?: ReadStructureContext } {
	let bytes = context.limits.bytes;
	let lines = context.limits.lines;
	const structureText = formatReadStructureContext(structure);
	if (structure === undefined || structureText === undefined || !reserveFits(structureText, bytes, lines)) {
		return { slice: initialSlice };
	}

	bytes -= renderedBytes(structureText);
	lines -= renderedLines(structureText);
	const sliced = context.filesystem.content.sliceText(content, {
		...sliceOptions(range, path, context),
		maxBytes: bytes,
		maxLines: lines,
	});
	if (!sliced.ok) return { slice: initialSlice };
	return { slice: sliced.value, structure };
}

function sliceOptions(range: ReadRange | undefined, path: string, context: ReadCommandContext) {
	return {
		...(range === undefined ? {} : { startLine: range.start }),
		...(range?.end === undefined ? {} : { endLine: range.end }),
		maxBytes: context.limits.bytes,
		maxLines: context.limits.lines,
		path,
	};
}

async function safeStructureContext(
	source: ReadStructureSource | undefined,
	file: FileRef,
	content: string,
	slice: TextSlice,
	partial: boolean,
	operation: FsOperationContext,
) {
	try {
		return await source?.context({
			file,
			content,
			startLine: slice.startLine,
			endLine: slice.endLine,
			partial,
			truncated: slice.truncated || slice.continuation !== undefined,
			...(operation.signal === undefined ? {} : { signal: operation.signal }),
		});
	} catch {
		return undefined;
	}
}

async function processImage(
	processor: InlineImageProcessor,
	operation: FsOperationContext,
	input: Parameters<InlineImageProcessor["process"]>[0],
) {
	try {
		return await processor.process(input);
	} catch (error) {
		if (!isAborted(operation)) throw error;
		return undefined;
	}
}

function applyIgnore(result: ReadFileSuccess, ignoreSource: string | undefined): void {
	if (ignoreSource === undefined) return;
	result.ignored = true;
	result.ignore_source = ignoreSource;
}

function shortIgnoreSource(source: string | undefined): string | undefined {
	if (source === undefined) return undefined;
	const normalized = source.replaceAll("\\", "/");
	if (normalized.endsWith("/.git/info/exclude") || normalized === ".git/info/exclude") return ".git/info/exclude";
	if (normalized.endsWith("/.piignore") || normalized === ".piignore") return ".piignore";
	if (normalized.endsWith("/.gitignore") || normalized === ".gitignore") return ".gitignore";
	if (normalized.endsWith("/file-tools.jsonc") || normalized === "file-tools.jsonc" || normalized === "config") return "file-tools.jsonc";
	return source;
}

function parseRanges(params: ReadParams): ParsedReadRanges | ToolOutcome<never> {
	if (params.lines !== undefined) {
		const parsed = parseReadRange(params.lines, "lines");
		if (!parsed.ok) return fail("INVALID_PATH", parsed.message, { path: params.path });
		return { lines: parsed.value };
	}
	if (params.pages !== undefined) {
		const parsed = parseReadRange(params.pages, "pages");
		if (!parsed.ok) return fail("INVALID_PATH", parsed.message, { path: params.path });
		return { pages: parsed.value };
	}
	return {};
}

interface ParsedReadRanges {
	readonly lines?: ReadRange;
	readonly pages?: ReadRange;
}

function reserveFits(rendered: string, bytes: number, lines: number): boolean {
	return renderedBytes(rendered) < bytes && renderedLines(rendered) < lines;
}

function renderedBytes(rendered: string): number {
	return Buffer.byteLength(`${rendered}\n`, "utf8");
}

function renderedLines(rendered: string): number {
	return rendered.split(/\r\n|\r|\n/u).length;
}

function uniquePaths(paths: readonly string[], limit: number): string[] {
	return [...new Set(paths.filter((path) => path.length > 0))].slice(0, limit);
}

function isAborted(operation: FsOperationContext): boolean {
	return operation.signal?.aborted === true;
}

function aborted(path: string) {
	return fail("OPERATION_ABORTED", "Operation aborted.", { path });
}
