import type { FileToolLimits } from "../../file-tool-limits.ts";
import type { ContentVersion, TextContent } from "../../filesystem/contracts/content.ts";
import type { MutationSnapshot } from "../../filesystem/contracts/mutation.ts";
import type { FileRef, TargetRef } from "../../filesystem/contracts/path.ts";
import type { FsOperationContext } from "../../filesystem/contracts/result.ts";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.ts";
import type { LspMutationBaseline as DiagnosticSnapshot } from "../../lsp/types.ts";
import {
	captureMutationDiagnostics,
	collectMutationDiagnostics,
	type MutationDiagnosticsSource,
} from "../shared/mutation-diagnostics.ts";
import { fail, isFailed, mapFsError, type FailedResult, type ToolOutcome } from "../shared/result.ts";
import type { TextDiffGenerator } from "../shared/text-diff.ts";
import { validateReplacements } from "./validation.ts";
import type { EditLineRange, EditParams, EditPreviewSuccess, EditReplacement, EditSuccess } from "./types.ts";

const encoder = new TextEncoder();
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

interface EditedContent {
	readonly file: TextContent;
	readonly updatedText: string;
	readonly changedRanges: readonly EditLineRange[];
	readonly preview: EditPreviewSuccess;
}

interface PreparedEdit extends EditedContent {
	readonly baseline: DiagnosticSnapshot | undefined;
}

interface EditObservationStore {
	get(target: TargetRef): ContentVersion | undefined;
}

export interface EditCommandContext extends EditPreviewContext {
	readonly observation: EditObservationStore;
	readonly diagnostics?: MutationDiagnosticsSource;
	readonly onPrepared?: (preview: EditPreviewSuccess) => void;
}

export interface EditPreviewContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly limits: Readonly<Pick<FileToolLimits, "edit_max_file_bytes" | "edit_match_hint_limit">>;
	readonly diff: TextDiffGenerator;
}

/** Applies exact replacements against the queued current snapshot. */
export async function editFile(params: EditParams, context: EditCommandContext): Promise<ToolOutcome<EditSuccess>> {
	const target = await resolveEditMutationTarget(params.path, context.filesystem);
	if (isFailed(target)) return target;

	const mutated = await context.filesystem.mutations.run<PreparedEdit, FailedResult>(
		target,
		{
			createParents: false,
			maxSnapshotBytes: context.limits.edit_max_file_bytes,
			maxOutputBytes: context.limits.edit_max_file_bytes,
		},
		async (snapshot) => {
			const file = validateSnapshot(snapshot, target, context);
			if (isFailed(file)) return { type: "reject", reason: file };
			const prepared = await prepareEdit(file, target.displayPath, params.edits, context);
			if (isFailed(prepared)) return { type: "reject", reason: prepared };
			const bytes = buildTextBytes(prepared.updatedText, file.hasBom);
			safePrepared(context.onPrepared, { ...prepared.preview });
			const baseline = await captureMutationDiagnostics(context.diagnostics, target, context.operation.signal);
			return { type: "commit", bytes, prepared: { ...prepared, baseline } };
		},
	);
	if (!mutated.ok) return mapMutationError(mutated.error);
	if (!mutated.value.committed) return mutated.value.reason;
	const { receipt, prepared } = mutated.value;
	const { file: before, updatedText, changedRanges, preview, baseline } = prepared;
	const result: EditSuccess = {
		...preview,
		status: "applied",
		path: receipt.target.displayPath,
		old_version: before.hash,
		new_version: receipt.hash,
		old_size_bytes: before.sizeBytes,
		new_size_bytes: receipt.sizeBytes,
	};
	const diagnostics = await collectMutationDiagnostics(context.diagnostics, {
		target: receipt.target,
		content: updatedText,
		created: false,
		changedRanges,
		...(baseline === undefined ? {} : { baseline }),
		...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
	});
	if (diagnostics !== undefined) result.lsp = { diagnostics };
	return result;
}

/** Builds a read-only preview without creating an observation. */
export async function previewEdit(params: EditParams, context: EditPreviewContext): Promise<ToolOutcome<EditPreviewSuccess>> {
	const file = await resolveEditFile(params.path, context.filesystem);
	if (isFailed(file)) return file;
	const loaded = await context.filesystem.content.readBytes(
		file,
		{ maxBytes: context.limits.edit_max_file_bytes },
	);
	if (!loaded.ok) return mapFsError(loaded.error, { notFound: "file" });
	const decoded = context.filesystem.content.decodeText(loaded.value, file.displayPath);
	if (!decoded.ok) return mapFsError(decoded.error, { notFound: "file" });
	const prepared = await prepareEdit(decoded.value, file.displayPath, params.edits, context);
	return isFailed(prepared) ? prepared : prepared.preview;
}

/** 预览与提交共用替换、字节上限及 diff 准备；只在提交时编码输出。 */
async function prepareEdit(
	file: TextContent,
	path: string,
	edits: readonly EditReplacement[],
	context: EditPreviewContext,
): Promise<ToolOutcome<EditedContent>> {
	const updated = applyReplacements(file.text, edits, path, context.limits.edit_match_hint_limit);
	if (isFailed(updated)) return updated;
	const outputError = validateTextSize(updated.text, file.hasBom, path, context.limits.edit_max_file_bytes);
	if (outputError !== undefined) return outputError;
	const rendered = await context.diff.generate(normalizeLineEndings(file.text), normalizeLineEndings(updated.text));
	return {
		file,
		updatedText: updated.text,
		changedRanges: updated.changedRanges,
		preview: { status: "preview", path, replacements: updated.replacements, ...rendered },
	};
}

async function resolveEditMutationTarget(
	path: string,
	filesystem: WorkspaceFileSystem,
): Promise<ToolOutcome<TargetRef>> {
	const target = await filesystem.paths.resolveTarget(path);
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
): Promise<ToolOutcome<FileRef>> {
	const existing = await filesystem.paths.resolveExisting(path, { expected: "file", followFinalSymlink: true });
	if (!existing.ok) return mapFsError(existing.error, { notFound: "file" });
	const visibility = await filesystem.visibility.evaluate(existing.value, "explicit-edit");
	if (!visibility.ok) return mapFsError(visibility.error);
	return existing.value;
}

function validateSnapshot(
	snapshot: MutationSnapshot,
	target: TargetRef,
	context: EditCommandContext,
): ToolOutcome<TextContent> {
	if (!snapshot.exists) return fail("FILE_NOT_FOUND", "File does not exist.", { path: target.displayPath });
	const file = context.filesystem.content.decodeText(
		{ bytes: snapshot.bytes, hash: snapshot.hash, sizeBytes: snapshot.sizeBytes },
		target.displayPath,
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
	return file.value;
}

function applyReplacements(
	text: string,
	replacements: readonly EditReplacement[],
	path: string,
	hintLimit: number,
): ToolOutcome<{ text: string; replacements: number; changedRanges: readonly EditLineRange[] }> {
	const matches = validateReplacements(text, replacements, path, hintLimit);
	if (isFailed(matches)) return matches;
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

function buildTextBytes(text: string, hasBom: boolean): Uint8Array {
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
