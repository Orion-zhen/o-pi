import type { MutationSnapshot } from "../../filesystem/contracts/mutation.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import type { DiagnosticSnapshot } from "../shared/diagnostics.js";
import {
	captureMutationDiagnostics,
	collectMutationDiagnostics,
	type MutationDiagnosticsSource,
} from "../shared/mutation-diagnostics.js";
import { fail, mapFsError, type ToolOutcome } from "../shared/result.js";
import type { TextDiff, TextDiffGenerator } from "../shared/text-diff.js";
import type { WriteParams, WritePreviewSuccess, WriteSuccess } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

export interface WriteCommandContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly maxFileBytes: number;
	readonly diff: TextDiffGenerator;
	readonly diagnostics?: MutationDiagnosticsSource;
	readonly onPrepared?: (preview: WritePreviewSuccess) => void;
}

/** Creates or fully overwrites one guarded UTF-8 file. */
export async function writeFile(params: WriteParams, context: WriteCommandContext): Promise<ToolOutcome<WriteSuccess>> {
	const inputBytes = Buffer.byteLength(params.content, "utf8");
	if (inputBytes > context.maxFileBytes) return fileTooLarge(params.path, context.maxFileBytes, inputBytes);
	const target = await context.filesystem.paths.resolveTarget(params.path);
	if (!target.ok) return mapFsError(target.error);
	if (target.value.workspacePath === ".") {
		return fail("INVALID_PATH", "Target must be a file path, not the current directory.", { path: params.path });
	}

	const bytes = encoder.encode(params.content);
	let snapshot: MutationSnapshot | undefined;
	let renderedDiff: TextDiff | undefined;
	let baseline: DiagnosticSnapshot | undefined;
	const mutated = await context.filesystem.mutations.run(
		target.value,
		{
			createParents: true,
			maxSnapshotBytes: context.maxFileBytes,
			maxOutputBytes: context.maxFileBytes,
		},
		async (current) => {
			snapshot = current;
			renderedDiff = await context.diff.generate(normalizeLineEndings(snapshotText(current)), normalizeLineEndings(params.content));
			safePrepared(context.onPrepared, {
				status: "preview",
				path: target.value.displayPath,
				diff: renderedDiff.diff,
				...(renderedDiff.firstChangedLine === undefined ? {} : { firstChangedLine: renderedDiff.firstChangedLine }),
			});
			baseline = await captureMutationDiagnostics(context.diagnostics, target.value, context.operation.signal);
			return { type: "commit", bytes };
		},
	);
	if (!mutated.ok) return mapFsError(mutated.error);
	if (!mutated.value.committed || snapshot === undefined || renderedDiff === undefined) {
		return fail("ACCESS_DENIED", "File could not be written.", { path: target.value.displayPath });
	}

	const receipt = mutated.value.receipt;
	const result: WriteSuccess = {
		status: "written",
		path: receipt.target.displayPath,
		bytes: receipt.sizeBytes,
		action: receipt.created ? "create" : "modify",
		...(receipt.before === undefined ? {} : {
			before_version: receipt.before.hash,
			before_size_bytes: receipt.before.sizeBytes,
		}),
		after_version: receipt.hash,
		after_size_bytes: receipt.sizeBytes,
		diff: renderedDiff.diff,
		...(renderedDiff.firstChangedLine === undefined ? {} : { firstChangedLine: renderedDiff.firstChangedLine }),
	};

	const diagnostics = await collectMutationDiagnostics(context.diagnostics, {
		target: receipt.target,
		content: params.content,
		created: receipt.created,
		...(baseline === undefined ? {} : { baseline }),
		...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
	});
	if (diagnostics !== undefined) result.lsp = { diagnostics };
	return result;
}

function fileTooLarge(path: string, limit: number, size: number) {
	return fail("OUTPUT_LIMIT_EXCEEDED", "File exceeds the configured byte limit.", {
		path,
		details: { limit, size },
	});
}

function snapshotText(snapshot: MutationSnapshot): string {
	return snapshot.exists ? decoder.decode(snapshot.bytes) : "";
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function safePrepared(observer: WriteCommandContext["onPrepared"], preview: WritePreviewSuccess): void {
	try {
		observer?.(preview);
	} catch {}
}
