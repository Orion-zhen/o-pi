import type { ContentVersion, TextContent } from "../../filesystem/contracts/content.js";
import type { MutationSnapshot } from "../../filesystem/contracts/mutation.js";
import type { FileRef, TargetRef } from "../../filesystem/contracts/path.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import type { DiagnosticSnapshot } from "../shared/diagnostics.js";
import { fail, isFailed, mapFsError, type FailedResult, type ToolOutcome } from "../shared/result.js";
import type { TextDiff, TextDiffGenerator } from "../shared/text-diff.js";
import { buildEditMatchHints } from "./hints.js";
import type { EditDiagnosticsSource, EditMutationObserver } from "./ports.js";
import type { EditParams, EditPreviewSuccess, EditReplacement, EditSuccess } from "./types.js";

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
	readonly mutationObserver?: EditMutationObserver;
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
	const resolved = await resolveEditTarget(input.path, context.filesystem, context.operation);
	if (isFailed(resolved)) return resolved;
	const { target } = resolved;

	let before: TextContent | undefined;
	let updatedText: string | undefined;
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
			const output = buildTextBytes(updatedText, before.hasBom, target.displayPath, context.maxFileBytes);
			if (isFailed(output)) return { type: "reject", reason: output };
			renderedDiff = await context.diff.generate(normalizeLineEndings(before.text), normalizeLineEndings(updatedText));
			baseline = await safeBeforeEdit(context.diagnostics, target, context.operation.signal);
			return { type: "commit", bytes: output };
		},
		context.operation,
	);
	if (!mutated.ok) return mapMutationError(mutated.error);
	if (!mutated.value.committed) return mutated.value.reason;
	if (before === undefined || updatedText === undefined || renderedDiff === undefined) {
		return fail("ACCESS_DENIED", "File could not be written.", { path: target.displayPath });
	}

	const receipt = mutated.value.receipt;
	const result: EditSuccess = {
		status: "applied",
		path: receipt.target.displayPath,
		replacements: input.edits.length,
		old_version: before.hash,
		new_version: receipt.hash,
		old_size_bytes: before.sizeBytes,
		new_size_bytes: receipt.sizeBytes,
		diff: renderedDiff.diff,
		...(renderedDiff.firstChangedLine === undefined ? {} : { firstChangedLine: renderedDiff.firstChangedLine }),
	};
	const [diagnostics, graph] = await Promise.all([
		safeAfterEdit(context.diagnostics, receipt.target, updatedText, baseline, context.operation.signal),
		safeMutationObserver(context.mutationObserver, receipt.target, renderedDiff.firstChangedLine, context.operation.signal),
	]);
	if (diagnostics !== undefined) result.lsp = { diagnostics };
	if (graph !== undefined) result.repo_map = graph;
	return result;
}

/** Builds a read-only preview without creating an observation. */
export async function previewEdit(params: unknown, context: EditPreviewContext): Promise<ToolOutcome<EditPreviewSuccess>> {
	const input = validateEditInput(params);
	if (isFailed(input)) return input;
	const resolved = await resolveEditTarget(input.path, context.filesystem, context.operation);
	if (isFailed(resolved)) return resolved;
	const loaded = await context.filesystem.content.readBytes(
		resolved.file,
		{ stable: true, maxBytes: context.maxFileBytes },
		context.operation,
	);
	if (!loaded.ok) return mapFsError(loaded.error, { notFound: "file" });
	const decoded = context.filesystem.content.decodeText(loaded.value, { rejectBinary: true, path: resolved.file.displayPath });
	if (!decoded.ok) return mapFsError(decoded.error, { notFound: "file" });
	const updated = applyReplacements(decoded.value.text, input.edits, resolved.file.displayPath, context.matchHintLimit);
	if (isFailed(updated)) return updated;
	const outputError = validateTextSize(updated, decoded.value.hasBom, resolved.file.displayPath, context.maxFileBytes);
	if (outputError !== undefined) return outputError;
	const rendered = await context.diff.generate(normalizeLineEndings(decoded.value.text), normalizeLineEndings(updated));
	return {
		status: "preview",
		path: resolved.file.displayPath,
		replacements: input.edits.length,
		diff: rendered.diff,
		...(rendered.firstChangedLine === undefined ? {} : { firstChangedLine: rendered.firstChangedLine }),
	};
}

async function resolveEditTarget(
	path: string,
	filesystem: WorkspaceFileSystem,
	operation: FsOperationContext,
): Promise<ToolOutcome<{ file: FileRef; target: TargetRef }>> {
	const existing = await filesystem.paths.resolveExisting(path, { expected: "file", followFinalSymlink: true }, operation);
	if (!existing.ok) return mapFsError(existing.error, { notFound: "file" });
	if (existing.value.kind !== "file") return fail("NOT_A_FILE", "Path is not a regular file.", { path: existing.value.displayPath });
	const visibility = await filesystem.visibility.evaluate(existing.value, "explicit-edit", operation);
	if (!visibility.ok) return mapFsError(visibility.error);
	const target = await filesystem.paths.resolveTarget(path, { followExistingSymlink: true }, operation);
	if (!target.ok) return mapFsError(target.error, { notFound: "file" });
	return { file: existing.value, target: target.value };
}

function prepareSnapshot(
	snapshot: MutationSnapshot,
	target: TargetRef,
	edits: readonly EditReplacement[],
	context: EditCommandContext,
): ToolOutcome<{ file: TextContent; updatedText: string }> {
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
	const updatedText = applyReplacements(file.value.text, edits, target.displayPath, context.matchHintLimit);
	return isFailed(updatedText) ? updatedText : { file: file.value, updatedText };
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
		if (key !== "old" && key !== "new") {
			return fail("INVALID_OPERATION", `Unsupported edits[${index}] field: ${key}.`, { edit_index: index, details: { field: key } });
		}
	}
	if (typeof value["old"] !== "string") return fail("INVALID_OPERATION", `edits[${index}].old must be a string.`, { edit_index: index });
	if (value["old"].length === 0) return fail("EMPTY_OLD_TEXT", `edits[${index}].old must not be empty.`, { edit_index: index });
	if (typeof value["new"] !== "string") return fail("INVALID_OPERATION", `edits[${index}].new must be a string.`, { edit_index: index });
	return { old: value["old"], new: value["new"] };
}

function applyReplacements(text: string, replacements: readonly EditReplacement[], path: string, hintLimit: number): ToolOutcome<string> {
	const matches: Array<{ index: number; start: number; end: number; replacement: EditReplacement }> = [];
	for (let index = 0; index < replacements.length; index += 1) {
		const replacement = replacements[index];
		if (replacement === undefined) continue;
		const starts = findAll(text, replacement.old);
		if (starts.length === 0) return fail("OLD_TEXT_NOT_FOUND", `edits[${index}].old was not found in the original file.`, { path, edit_index: index });
		if (starts.length > 1) {
			const hints = buildEditMatchHints(text, replacement.old, replacement.new, starts, hintLimit);
			const summary = hints.length < starts.length ? `${starts.length} locations, ${hints.length} shown` : `${starts.length} locations`;
			return fail("OLD_TEXT_NOT_UNIQUE", `edits[${index}].old matched ${summary}.`, {
				path,
				edit_index: index,
				next: "Retry with one shown old/new pair; read only if the file changed.",
				details: { matches: starts.length, shown: hints.length, hints },
			});
		}
		const start = starts[0];
		if (start !== undefined) matches.push({ index, start, end: start + replacement.old.length, replacement });
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
	let output = "";
	let cursor = 0;
	for (const match of matches) {
		output += text.slice(cursor, match.start) + match.replacement.new;
		cursor = match.end;
	}
	return output + text.slice(cursor);
}

function findAll(text: string, needle: string): number[] {
	const starts: number[] = [];
	let cursor = 0;
	while (cursor <= text.length - needle.length) {
		const found = text.indexOf(needle, cursor);
		if (found === -1) break;
		starts.push(found);
		cursor = found + Math.max(needle.length, 1);
	}
	return starts;
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

async function safeBeforeEdit(source: EditDiagnosticsSource | undefined, target: TargetRef, signal: AbortSignal | undefined) {
	try {
		return await source?.beforeEdit({ target, ...(signal === undefined ? {} : { signal }) });
	} catch {
		return undefined;
	}
}
async function safeAfterEdit(source: EditDiagnosticsSource | undefined, target: TargetRef, content: string, baseline: DiagnosticSnapshot | undefined, signal: AbortSignal | undefined) {
	try {
		return await source?.afterEdit({ target, content, ...(baseline === undefined ? {} : { baseline }), ...(signal === undefined ? {} : { signal }) });
	} catch {
		return undefined;
	}
}
async function safeMutationObserver(observer: EditMutationObserver | undefined, target: TargetRef, firstChangedLine: number | undefined, signal: AbortSignal | undefined) {
	try {
		return await observer?.observe({ target, ...(firstChangedLine === undefined ? {} : { firstChangedLine }), ...(signal === undefined ? {} : { signal }) });
	} catch {
		return undefined;
	}
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
