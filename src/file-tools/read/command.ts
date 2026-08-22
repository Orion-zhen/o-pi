import type { ContentVersion, TextContent, TextSlice } from "../../filesystem/contracts/content.js";
import type { FileRef } from "../../filesystem/contracts/path.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { fail, mapFsError, type ToolOutcome } from "../shared/result.js";
import { detectFileType } from "./media.js";
import type { InlineImageProcessor, ReadStructureSource } from "./ports.js";
import { formatReadStructureContext } from "./presenter.js";
import type { ReadFileSuccess, ReadOutputFormat, ReadParams, ReadStructureContext } from "./types.js";

const PATH_CATALOG_ENTRY_LIMIT = 10_000;

export interface ReadObservationStore {
	remember(file: FileRef, version: ContentVersion): boolean;
}

export interface ReadCommandContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly observation: ReadObservationStore;
	readonly limits: {
		readonly bytes: number;
		readonly fileBytes: number;
		readonly lines: number;
		readonly suggestions: number;
	};
	readonly structure?: ReadStructureSource;
	readonly image?: InlineImageProcessor;
	readonly supportedOutputFormats?: readonly ReadOutputFormat[];
	readonly recordObservation?: boolean;
}

/** Reads one guarded workspace file and composes only read-owned optional ports. */
export async function readFile(
	params: ReadParams,
	context: ReadCommandContext,
): Promise<ToolOutcome<ReadFileSuccess>> {
	const rangeError = validateRangeSyntax(params);
	if (rangeError !== undefined) return rangeError;

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
		if (params.start_line !== undefined || params.end_line !== undefined) {
			return fail("INVALID_OPERATION", "Line ranges apply only to text files.", { path: file.displayPath });
		}
		const image = await safeProcessImage(context.image, {
			bytes: loaded.value.bytes,
			mimeType: detected.mime,
			path: file.displayPath,
			...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
		});
		if (isAborted(context.operation)) return aborted(file.displayPath);
		if (image === undefined || !image.ok) {
			const resize = image?.reason === "resize";
			return fail("BINARY_FILE_UNSUPPORTED", resize
				? "Image cannot be resized below the inline model size limit."
				: "Image cannot be converted to an inline model-supported format.", {
				path: file.displayPath,
				details: { mime_type: image?.mimeType ?? detected.mime },
			});
		}
		remember(context, file, loaded.value);
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
	if (detected !== undefined) {
		return fail("BINARY_FILE_UNSUPPORTED", `${detected.kind} files are not supported by read.`, {
			path: file.displayPath,
			details: { mime_type: detected.mime, extension: detected.ext },
		});
	}

	const decoded = context.filesystem.content.decodeText(loaded.value, file.displayPath);
	if (!decoded.ok) return mapFsError(decoded.error, { notFound: "file" });
	remember(context, file, decoded.value);

	const initialSlice = context.filesystem.content.sliceText(decoded.value, sliceOptions(params, context));
	if (!initialSlice.ok) return mapFsError(initialSlice.error, { notFound: "file" });
	let sliced = initialSlice.value;
	const partial = params.start_line !== undefined || params.end_line !== undefined;
	const needsContext = partial || sliced.truncated || sliced.continuation !== undefined;
	let structure: ReadStructureContext | undefined;
	if (needsContext) {
		structure = await safeStructureContext(context.structure, file, decoded.value.text, sliced, partial, context.operation);
		if (isAborted(context.operation)) return aborted(file.displayPath);
		const budgeted = reserveContextBudget(params, context, decoded.value, sliced, structure);
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

async function missingPathSuggestions(input: string, context: ReadCommandContext): Promise<string[]> {
	const target = await context.filesystem.paths.resolveTarget(input, { followExistingSymlink: true });
	if (!target.ok || target.value.workspacePath === undefined || isAborted(context.operation)) return [];
	const catalog = await context.filesystem.catalog.suggest(
		context.filesystem.root,
		target.value.workspacePath,
		{ limit: context.limits.suggestions, maxEntries: PATH_CATALOG_ENTRY_LIMIT },
	);
	if (!catalog.ok) return [];
	return uniquePaths(catalog.value.map((candidate) => candidate.ref.workspacePath ?? candidate.ref.displayPath), context.limits.suggestions);
}

function reserveContextBudget(
	params: ReadParams,
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
		...sliceOptions(params, context),
		maxBytes: bytes,
		maxLines: lines,
	});
	if (!sliced.ok) return { slice: initialSlice };
	return { slice: sliced.value, structure };
}

function sliceOptions(params: ReadParams, context: ReadCommandContext) {
	return {
		...(params.start_line === undefined ? {} : { startLine: params.start_line }),
		...(params.end_line === undefined ? {} : { endLine: params.end_line }),
		maxBytes: context.limits.bytes,
		maxLines: context.limits.lines,
		path: params.path,
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

async function safeProcessImage(
	processor: InlineImageProcessor | undefined,
	input: Parameters<InlineImageProcessor["process"]>[0],
) {
	try {
		return await processor?.process(input);
	} catch {
		return undefined;
	}
}

function remember(context: ReadCommandContext, file: FileRef, version: ContentVersion): void {
	if (context.recordObservation !== false) context.observation.remember(file, version);
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

function validateRangeSyntax(params: ReadParams): ToolOutcome<never> | undefined {
	if (params.start_line !== undefined && params.end_line !== undefined && params.start_line > params.end_line) {
		return fail("INVALID_PATH", "start_line must be less than or equal to end_line.", { path: params.path });
	}
	return undefined;
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
