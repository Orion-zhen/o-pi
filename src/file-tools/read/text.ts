import type { TextContent, TextSlice } from "../../filesystem/contracts/content.js";
import type { FileRef } from "../../filesystem/contracts/path.js";
import { fail, isFailed, mapFsError, type ToolOutcome } from "../shared/result.js";
import type { ReadCommandContext } from "./command.js";
import { formatReadSegment, formatReadStructureContext } from "./presenter.js";
import { formatReadRanges, resolveReadRanges, type ReadRange, type ResolvedReadRange } from "./range.js";
import type { ReadStructureContext, ReadSuccess, ReadTextSegment } from "./types.js";

/** 从同一快照提取全部范围，正文与结构提示共享预算。 */
export async function readTextRanges(
	file: FileRef,
	content: TextContent,
	requested: readonly ReadRange[] | undefined,
	context: ReadCommandContext,
): Promise<ToolOutcome<ReadSuccess>> {
	const ranges = resolveReadRanges(requested, content.totalLines, "lines", file.displayPath);
	if (isFailed(ranges)) return ranges;
	const segments: ReadTextSegment[] = [];
	let remainingBytes = context.limits.read_bytes;
	let remainingLines = context.limits.read_lines;
	let continuation: ReadSuccess["continuation"];
	for (const [index, range] of ranges.entries()) {
		if (context.operation.signal?.aborted) return fail("OPERATION_ABORTED", "Operation aborted.", { path: file.displayPath });
		const wrapperBytes = ranges.length > 1 ? Buffer.byteLength(formatReadSegment("\n", range.start, range.end)) : 0;
		const maxBytes = remainingBytes - wrapperBytes;
		if (maxBytes <= 0 || remainingLines <= 0) {
			continuation = { lines: formatReadRanges(ranges.slice(index)) };
			break;
		}
		const options = { startLine: range.start, endLine: range.end, maxBytes, maxLines: remainingLines, path: file.displayPath };
		const initial = context.filesystem.content.sliceText(content, options);
		if (!initial.ok) {
			// 前面的片段已消耗预算，下一整行留给后续调用，而不是丢弃已有结果。
			if (initial.error.code === "too-large" && segments.length > 0) {
				continuation = { lines: formatReadRanges(ranges.slice(index)) };
				break;
			}
			return mapFsError(initial.error, { notFound: "file" });
		}
		let slice = initial.value;
		let structure = await structureContext(file, content, slice, requested !== undefined, context);
		if (context.operation.signal?.aborted) return fail("OPERATION_ABORTED", "Operation aborted.", { path: file.displayPath });
		let structureText = formatReadStructureContext(structure);
		if (structureText !== undefined) {
			const bytes = Buffer.byteLength(`${structureText}\n`);
			const lines = structureText.split(/\r\n|\r|\n/u).length;
			const reserved = bytes < maxBytes && lines < remainingLines
				? context.filesystem.content.sliceText(content, { ...options, maxBytes: maxBytes - bytes, maxLines: remainingLines - lines })
				: undefined;
			if (reserved?.ok && reserved.value.endLine >= reserved.value.startLine) slice = reserved.value;
			else {
				structure = undefined;
				structureText = undefined;
			}
		}
		segments.push({
			content: slice.content,
			start_line: slice.startLine,
			end_line: slice.endLine,
			...(structure === undefined ? {} : { lsp: structure }),
		});
		remainingBytes -= wrapperBytes + Buffer.byteLength(slice.content) + (structureText === undefined ? 0 : Buffer.byteLength(`${structureText}\n`));
		remainingLines -= Math.max(0, slice.endLine - slice.startLine + 1) + (structureText === undefined ? 0 : structureText.split(/\r\n|\r|\n/u).length);
		if (slice.continuation !== undefined) {
			continuation = { lines: formatReadRanges(remainingRanges(ranges, index, slice.continuation.startLine)) };
			break;
		}
	}
	if (segments.length === 0) return fail("OUTPUT_LIMIT_EXCEEDED", "No text fits the output limit.", { path: file.displayPath });
	return {
		path: file.displayPath,
		segments,
		total_lines: content.totalLines,
		size_bytes: content.sizeBytes,
		version: content.hash,
		encoding: "utf-8",
		newline: content.newline,
		bom: content.hasBom,
		truncated: continuation !== undefined,
		...(continuation === undefined ? {} : { continuation }),
	};
}

function remainingRanges(ranges: readonly ResolvedReadRange[], index: number, start: number): ResolvedReadRange[] {
	return ranges.slice(index).map((range, offset) => offset === 0 ? { ...range, start } : range);
}

async function structureContext(
	file: FileRef,
	content: TextContent,
	slice: TextSlice,
	partial: boolean,
	context: ReadCommandContext,
): Promise<ReadStructureContext | undefined> {
	if (!partial && !slice.truncated) return undefined;
	try {
		return await context.structure?.context({
			file,
			content: content.text,
			startLine: slice.startLine,
			endLine: slice.endLine,
			partial,
			truncated: slice.truncated,
			...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
		});
	} catch {
		return undefined;
	}
}
