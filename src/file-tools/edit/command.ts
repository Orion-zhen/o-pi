import type { ContentVersion, TextContent } from "../../filesystem/contracts/content.js";
import type { MutationSnapshot } from "../../filesystem/contracts/mutation.js";
import type { FileRef, TargetRef } from "../../filesystem/contracts/path.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import type { DiagnosticSnapshot } from "../shared/diagnostics.js";
import { fail, isFailed, mapFsError, type FailedResult, type ToolOutcome } from "../shared/result.js";
import type { TextDiff, TextDiffGenerator } from "../shared/text-diff.js";
import { buildEditMatchHints, buildEditNotFoundRecovery } from "./hints.js";
import { findAll } from "./matches.js";
import type { EditDiagnosticsSource } from "./ports.js";
import type { EditLineRange, EditParams, EditPreviewSuccess, EditReplacement, EditSuccess } from "./types.js";

const encoder = new TextEncoder();
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

interface EditObservationStore {
	get(target: TargetRef): ContentVersion | undefined;
}

export interface EditCommandContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly observation: EditObservationStore;
	readonly maxFileBytes: number;
	readonly matchHintLimit: number;
	readonly diff: TextDiffGenerator;
	readonly diagnostics?: EditDiagnosticsSource;
	readonly onPrepared?: (preview: EditPreviewSuccess) => void;
}

export interface EditPreviewContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly maxFileBytes: number;
	readonly matchHintLimit: number;
	readonly diff: TextDiffGenerator;
}

/** Applies exact replacements against the queued current snapshot. */
export async function editFile(params: unknown, context: EditCommandContext): Promise<ToolOutcome<EditSuccess>> {
	const input = validateEditInput(params);
	if (isFailed(input)) return input;
	const target = await resolveEditMutationTarget(input.path, context.filesystem, context.operation);
	if (isFailed(target)) return target;

	let before: TextContent | undefined;
	let updatedText: string | undefined;
	let replacementCount: number | undefined;
	let changedRanges: readonly EditLineRange[] | undefined;
	let renderedDiff: TextDiff | undefined;
	let baseline: DiagnosticSnapshot | undefined;
	const mutated = await context.filesystem.mutations.run<FailedResult>(
		target,
		{
			createParents: false,
			maxSnapshotBytes: context.maxFileBytes,
			maxOutputBytes: context.maxFileBytes,
		},
		async (snapshot) => {
			const prepared = prepareSnapshot(snapshot, target, input.edits, context);
			if (isFailed(prepared)) return { type: "reject", reason: prepared };
			before = prepared.file;
			updatedText = prepared.updatedText;
			replacementCount = prepared.replacementCount;
			changedRanges = prepared.changedRanges;
			const output = buildTextBytes(updatedText, before.hasBom, target.displayPath, context.maxFileBytes);
			if (isFailed(output)) return { type: "reject", reason: output };
			renderedDiff = await context.diff.generate(normalizeLineEndings(before.text), normalizeLineEndings(updatedText));
			safePrepared(context.onPrepared, {
				status: "preview",
				path: target.displayPath,
				replacements: replacementCount,
				diff: renderedDiff.diff,
				...(renderedDiff.firstChangedLine === undefined ? {} : { firstChangedLine: renderedDiff.firstChangedLine }),
			});
			baseline = await safeBeforeEdit(context.diagnostics, target, context.operation.signal);
			return { type: "commit", bytes: output };
		},
		context.operation,
	);
	if (!mutated.ok) return mapMutationError(mutated.error);
	if (!mutated.value.committed) return mutated.value.reason;
	if (before === undefined || updatedText === undefined || replacementCount === undefined || changedRanges === undefined || renderedDiff === undefined) {
		return fail("ACCESS_DENIED", "File could not be written.", { path: target.displayPath });
	}

	const receipt = mutated.value.receipt;
	const result: EditSuccess = {
		status: "applied",
		path: receipt.target.displayPath,
		replacements: replacementCount,
		old_version: before.hash,
		new_version: receipt.hash,
		old_size_bytes: before.sizeBytes,
		new_size_bytes: receipt.sizeBytes,
		diff: renderedDiff.diff,
		...(renderedDiff.firstChangedLine === undefined ? {} : { firstChangedLine: renderedDiff.firstChangedLine }),
	};
	const diagnostics = await safeAfterEdit(
		context.diagnostics,
		receipt.target,
		updatedText,
		changedRanges,
		baseline,
		context.operation.signal,
	);
	if (diagnostics !== undefined) result.lsp = { diagnostics };
	return result;
}

/** Builds a read-only preview without creating an observation. */
export async function previewEdit(params: unknown, context: EditPreviewContext): Promise<ToolOutcome<EditPreviewSuccess>> {
	const input = validateEditInput(params);
	if (isFailed(input)) return input;
	const file = await resolveEditFile(input.path, context.filesystem, context.operation);
	if (isFailed(file)) return file;
	const loaded = await context.filesystem.content.readBytes(
		file,
		{ stable: true, maxBytes: context.maxFileBytes },
		context.operation,
	);
	if (!loaded.ok) return mapFsError(loaded.error, { notFound: "file" });
	const decoded = context.filesystem.content.decodeText(loaded.value, { rejectBinary: true, path: file.displayPath });
	if (!decoded.ok) return mapFsError(decoded.error, { notFound: "file" });
	const updated = applyReplacements(decoded.value.text, input.edits, file.displayPath, context.matchHintLimit);
	if (isFailed(updated)) return updated;
	const outputError = validateTextSize(updated.text, decoded.value.hasBom, file.displayPath, context.maxFileBytes);
	if (outputError !== undefined) return outputError;
	const rendered = await context.diff.generate(normalizeLineEndings(decoded.value.text), normalizeLineEndings(updated.text));
	return {
		status: "preview",
		path: file.displayPath,
		replacements: updated.replacements,
		diff: rendered.diff,
		...(rendered.firstChangedLine === undefined ? {} : { firstChangedLine: rendered.firstChangedLine }),
	};
}

async function resolveEditMutationTarget(
	path: string,
	filesystem: WorkspaceFileSystem,
	operation: FsOperationContext,
): Promise<ToolOutcome<TargetRef>> {
	const target = await filesystem.paths.resolveTarget(path, { followExistingSymlink: true }, operation);
	if (!target.ok) return mapFsError(target.error, { notFound: "file" });
	if (target.value.existingKind === undefined) {
		return fail("FILE_NOT_FOUND", "File does not exist.", { path: target.value.displayPath });
	}
	if (target.value.existingKind !== "file") {
		return fail("NOT_A_FILE", "Path is not a regular file.", { path: target.value.displayPath });
	}
	return target.value;
}

async function resolveEditFile(
	path: string,
	filesystem: WorkspaceFileSystem,
	operation: FsOperationContext,
): Promise<ToolOutcome<FileRef>> {
	const existing = await filesystem.paths.resolveExisting(path, { expected: "file", followFinalSymlink: true }, operation);
	if (!existing.ok) return mapFsError(existing.error, { notFound: "file" });
	if (existing.value.kind !== "file") return fail("NOT_A_FILE", "Path is not a regular file.", { path: existing.value.displayPath });
	const visibility = await filesystem.visibility.evaluate(existing.value, "explicit-edit", operation);
	if (!visibility.ok) return mapFsError(visibility.error);
	return existing.value;
}

function prepareSnapshot(
	snapshot: MutationSnapshot,
	target: TargetRef,
	edits: readonly EditReplacement[],
	context: EditCommandContext,
): ToolOutcome<{ file: TextContent; updatedText: string; replacementCount: number; changedRanges: readonly EditLineRange[] }> {
	if (!snapshot.exists) return fail("FILE_NOT_FOUND", "File does not exist.", { path: target.displayPath });
	const file = context.filesystem.content.decodeText(
		{ bytes: snapshot.bytes, hash: snapshot.hash, sizeBytes: snapshot.sizeBytes },
		{ rejectBinary: true, path: target.displayPath },
	);
	if (!file.ok) return mapFsError(file.error, { notFound: "file" });
	const expected = context.observation.get(target);
	if (expected === undefined) {
		return fail("READ_REQUIRED", "Read the file before editing it.", {
			path: target.displayPath,
			next: "Read the file, then create a new edit operation.",
		});
	}
	if (expected.hash !== file.value.hash) {
		return fail("STALE_READ", "The file changed after it was read. Read the file again before editing.", {
			path: target.displayPath,
			next: "Read the file again, then create a new edit operation.",
			expected: expected.hash,
			actual: file.value.hash,
		});
	}
	const updated = applyReplacements(file.value.text, edits, target.displayPath, context.matchHintLimit);
	return isFailed(updated) ? updated : {
		file: file.value,
		updatedText: updated.text,
		replacementCount: updated.replacements,
		changedRanges: updated.changedRanges,
	};
}

function validateEditInput(params: unknown): ToolOutcome<EditParams> {
	if (!isPlainRecord(params)) return fail("INVALID_OPERATION", "edit input must be an object.");
	for (const key of Object.keys(params)) {
		if (key !== "path" && key !== "edits") {
			return fail("INVALID_OPERATION", `Unsupported edit field: ${key}.`, { details: { field: key } });
		}
	}
	if (typeof params["path"] !== "string") return fail("INVALID_OPERATION", "path must be a string.");
	if (!Array.isArray(params["edits"]) || params["edits"].length === 0) return fail("INVALID_OPERATION", "edits must be a non-empty array.");
	const edits: EditReplacement[] = [];
	for (let index = 0; index < params["edits"].length; index += 1) {
		const replacement = validateReplacement(params["edits"][index], index);
		if (isFailed(replacement)) return replacement;
		edits.push(replacement);
	}
	return { path: params["path"], edits };
}

function validateReplacement(value: unknown, index: number): ToolOutcome<EditReplacement> {
	if (!isPlainRecord(value)) return fail("INVALID_OPERATION", "edit entry must be an object.", { edit_index: index });
	for (const key of Object.keys(value)) {
		if (key !== "old" && key !== "new" && key !== "replace_all") {
			return fail("INVALID_OPERATION", `Unsupported edits[${index}] field: ${key}.`, { edit_index: index, details: { field: key } });
		}
	}
	if (typeof value["old"] !== "string") return fail("INVALID_OPERATION", `edits[${index}].old must be a string.`, { edit_index: index });
	if (value["old"].length === 0) return fail("EMPTY_OLD_TEXT", `edits[${index}].old must not be empty.`, { edit_index: index });
	if (typeof value["new"] !== "string") return fail("INVALID_OPERATION", `edits[${index}].new must be a string.`, { edit_index: index });
	if (value["replace_all"] !== undefined && typeof value["replace_all"] !== "boolean") {
		return fail("INVALID_OPERATION", `edits[${index}].replace_all must be a boolean.`, { edit_index: index });
	}
	return { old: value["old"], new: value["new"], replace_all: value["replace_all"] ?? false };
}

function applyReplacements(
	text: string,
	replacements: readonly EditReplacement[],
	path: string,
	hintLimit: number,
): ToolOutcome<{ text: string; replacements: number; changedRanges: readonly EditLineRange[] }> {
	const matches: Array<{ index: number; start: number; end: number; replacement: EditReplacement }> = [];
	for (let index = 0; index < replacements.length; index += 1) {
		const replacement = replacements[index];
		if (replacement === undefined) continue;
		const starts = findAll(text, replacement.old);
		if (starts.length === 0) return notFoundFailure(text, replacement.old, replacements.slice(0, index), path, index, hintLimit);
		if (starts.length > 1 && replacement.replace_all !== true) {
			const hints = buildEditMatchHints(text, replacement.old, replacement.new, starts, hintLimit);
			const summary = hints.length < starts.length ? `${starts.length} locations, ${hints.length} shown` : `${starts.length} locations`;
			return fail("OLD_TEXT_NOT_UNIQUE", `edits[${index}].old matched ${summary}.`, {
				path,
				edit_index: index,
				next: "Retry with one shown old/new pair; read only if the file changed.",
				details: { matches: starts.length, shown: hints.length, hints },
			});
		}
		for (const start of starts) matches.push({ index, start, end: start + replacement.old.length, replacement });
	}
	matches.sort((left, right) => left.start - right.start);
	for (let index = 1; index < matches.length; index += 1) {
		const previous = matches[index - 1];
		const current = matches[index];
		if (previous !== undefined && current !== undefined && current.start < previous.end) {
			return fail("OVERLAPPING_REPLACEMENTS", `edits[${previous.index}] and edits[${current.index}] overlap.`, {
				path,
				edit_index: current.index,
				details: { previous_edit_index: previous.index },
			});
		}
	}
	const outputChunks: string[] = [];
	const changedRanges: EditLineRange[] = [];
	let cursor = 0;
	let outputLine = 1;
	for (const match of matches) {
		const unchanged = text.slice(cursor, match.start);
		outputChunks.push(unchanged);
		outputLine += countLineFeeds(unchanged);

		const startLine = outputLine;
		outputChunks.push(match.replacement.new);
		outputLine += countLineFeeds(match.replacement.new);
		appendChangedRange(changedRanges, startLine, outputLine);
		cursor = match.end;
	}
	outputChunks.push(text.slice(cursor));
	return {
		text: outputChunks.join(""),
		replacements: matches.length,
		changedRanges,
	};
}

function notFoundFailure(
	text: string,
	old: string,
	previous: readonly EditReplacement[],
	path: string,
	index: number,
	hintLimit: number,
): FailedResult {
	const recovery = buildEditNotFoundRecovery(text, old, previous, hintLimit);
	switch (recovery.kind) {
		case "dependent":
			return fail("OLD_TEXT_NOT_FOUND", `edits[${index}].old is absent from the original file, but appears after edits[${recovery.afterEditIndex}].`, {
				path,
				edit_index: index,
				next: `Rewrite edits[${index}] against the original content, or merge the dependent changes into one replacement.`,
				details: { reason: "dependent_edit", after_edit_index: recovery.afterEditIndex },
			});
		case "format":
			return fail("OLD_TEXT_NOT_FOUND", `edits[${index}].old was not found exactly; one formatting-equivalent candidate exists.`, {
				path,
				edit_index: index,
				next: "Retry with the shown old text, adapting new if needed; read only if the file changed.",
				details: { reason: "format_drift", candidates: [recovery.candidate] },
			});
		case "anchors": {
			const shown = recovery.candidates.length;
			return fail("OLD_TEXT_NOT_FOUND", `edits[${index}].old was not found in the original file; ${shown} nearby ${shown === 1 ? "candidate" : "candidates"} shown.`, {
				path,
				edit_index: index,
				next: `Rewrite edits[${index}].old using a matching candidate, or read the file if none is correct.`,
				details: { reason: "anchor_candidates", shown, candidates: recovery.candidates },
			});
		}
		case "none":
			return fail("OLD_TEXT_NOT_FOUND", `edits[${index}].old was not found in the original file.`, {
				path,
				edit_index: index,
				next: "Refine your edit and try again.",
			});
	}
}

function buildTextBytes(
	text: string,
	hasBom: boolean,
	path: string,
	maxBytes: number,
): ToolOutcome<Uint8Array> {
	const outputError = validateTextSize(text, hasBom, path, maxBytes);
	if (outputError !== undefined) return outputError;
	const body = encoder.encode(text);
	if (!hasBom) return body;
	const bytes = new Uint8Array(UTF8_BOM.byteLength + body.byteLength);
	bytes.set(UTF8_BOM);
	bytes.set(body, UTF8_BOM.byteLength);
	return bytes;
}

function validateTextSize(text: string, hasBom: boolean, path: string, maxBytes: number): FailedResult | undefined {
	const size = Buffer.byteLength(text, "utf8") + (hasBom ? UTF8_BOM.byteLength : 0);
	if (size <= maxBytes) return undefined;
	return fail("OUTPUT_LIMIT_EXCEEDED", "File exceeds the configured byte limit.", {
		path,
		details: { limit: maxBytes, size },
	});
}

function countLineFeeds(text: string): number {
	let count = 0;
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) === 10) count += 1;
	}
	return count;
}

function appendChangedRange(ranges: EditLineRange[], startLine: number, endLine: number): void {
	const previous = ranges.at(-1);
	if (previous === undefined || startLine > previous.endLine + 1) {
		ranges.push({ startLine, endLine });
		return;
	}
	previous.endLine = Math.max(previous.endLine, endLine);
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function mapMutationError(error: Parameters<typeof mapFsError>[0]): FailedResult {
	if (error.code !== "changed-during-read") return mapFsError(error, { notFound: "file" });
	const expected = typeof error.details?.["expected"] === "string" ? error.details["expected"] : undefined;
	const actual = typeof error.details?.["actual"] === "string" ? error.details["actual"] : undefined;
	return fail("STALE_READ", "The file changed after it was read. Read the file again before editing.", {
		...(error.path === undefined ? {} : { path: error.path }),
		next: "Read the file again, then create a new edit operation.",
		...(expected === undefined ? {} : { expected }),
		...(actual === undefined ? {} : { actual }),
	});
}

function safePrepared(observer: EditCommandContext["onPrepared"], preview: EditPreviewSuccess): void {
	try {
		observer?.(preview);
	} catch {}
}

async function safeBeforeEdit(source: EditDiagnosticsSource | undefined, target: TargetRef, signal: AbortSignal | undefined) {
	try {
		return await source?.beforeEdit({ target, ...(signal === undefined ? {} : { signal }) });
	} catch {
		return undefined;
	}
}
async function safeAfterEdit(
	source: EditDiagnosticsSource | undefined,
	target: TargetRef,
	content: string,
	changedRanges: readonly EditLineRange[],
	baseline: DiagnosticSnapshot | undefined,
	signal: AbortSignal | undefined,
) {
	try {
		return await source?.afterEdit({ target, content, changedRanges, ...(baseline === undefined ? {} : { baseline }), ...(signal === undefined ? {} : { signal }) });
	} catch {
		return undefined;
	}
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
