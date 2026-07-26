import type { MutationSnapshot } from "../../filesystem/contracts/mutation.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { fail, isFailed, mapFsError, type ToolOutcome } from "../shared/result.js";
import type { TextDiff, TextDiffGenerator } from "../shared/text-diff.js";
import type { WriteDiagnosticsSource, WriteMutationObserver } from "./ports.js";
import type { WriteParams, WritePreviewSuccess, WriteSuccess } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

export interface WriteCommandContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly maxFileBytes: number;
	readonly diff: TextDiffGenerator;
	readonly diagnostics?: WriteDiagnosticsSource;
	readonly mutationObserver?: WriteMutationObserver;
	readonly onPrepared?: (preview: WritePreviewSuccess) => void;
}

/** Creates or fully overwrites one guarded UTF-8 file. */
export async function writeFile(params: unknown, context: WriteCommandContext): Promise<ToolOutcome<WriteSuccess>> {
	const input = validateWriteInput(params);
	if (isFailed(input)) return input;
	const inputBytes = Buffer.byteLength(input.content, "utf8");
	if (inputBytes > context.maxFileBytes) return fileTooLarge(input.path, context.maxFileBytes, inputBytes);
	const target = await context.filesystem.paths.resolveTarget(
		input.path,
		{ followExistingSymlink: true },
		context.operation,
	);
	if (!target.ok) return mapFsError(target.error);
	if (target.value.workspacePath === ".") {
		return fail("INVALID_PATH", "Target must be a file path, not the current directory.", { path: input.path });
	}

	const bytes = encoder.encode(input.content);
	let snapshot: MutationSnapshot | undefined;
	let renderedDiff: TextDiff | undefined;
	const mutated = await context.filesystem.mutations.run(
		target.value,
		{
			createParents: true,
			maxSnapshotBytes: context.maxFileBytes,
			maxOutputBytes: context.maxFileBytes,
		},
		async (current) => {
			snapshot = current;
			renderedDiff = await context.diff.generate(normalizeLineEndings(snapshotText(current)), normalizeLineEndings(input.content));
			safePrepared(context.onPrepared, {
				status: "preview",
				path: target.value.displayPath,
				diff: renderedDiff.diff,
				...(renderedDiff.firstChangedLine === undefined ? {} : { firstChangedLine: renderedDiff.firstChangedLine }),
			});
			return { type: "commit", bytes };
		},
		context.operation,
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

	const [diagnostics, graph] = await Promise.all([
		safeDiagnostics(context.diagnostics, receipt.target, input.content, context.operation.signal),
		safeMutationObserver(context.mutationObserver, receipt.target, renderedDiff.firstChangedLine, context.operation.signal),
	]);
	if (diagnostics !== undefined) result.lsp = { diagnostics };
	if (graph !== undefined) result.repo_map = graph;
	return result;
}

function fileTooLarge(path: string, limit: number, size: number) {
	return fail("OUTPUT_LIMIT_EXCEEDED", "File exceeds the configured byte limit.", {
		path,
		details: { limit, size },
	});
}

function validateWriteInput(params: unknown): ToolOutcome<WriteParams> {
	if (!isPlainRecord(params)) return fail("INVALID_OPERATION", "write input must be an object.");
	for (const key of Object.keys(params)) {
		if (key !== "path" && key !== "content") {
			return fail("INVALID_OPERATION", `Unsupported write field: ${key}.`, { details: { field: key } });
		}
	}
	if (typeof params["path"] !== "string") return fail("INVALID_OPERATION", "path must be a string.");
	if (typeof params["content"] !== "string") return fail("INVALID_OPERATION", "content must be a string.");
	return { path: params["path"], content: params["content"] };
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

async function safeDiagnostics(
	source: WriteDiagnosticsSource | undefined,
	target: Parameters<WriteDiagnosticsSource["afterWrite"]>[0]["target"],
	content: string,
	signal: AbortSignal | undefined,
) {
	try {
		return await source?.afterWrite({ target, content, ...(signal === undefined ? {} : { signal }) });
	} catch {
		return undefined;
	}
}

async function safeMutationObserver(
	observer: WriteMutationObserver | undefined,
	target: Parameters<WriteMutationObserver["observe"]>[0]["target"],
	firstChangedLine: number | undefined,
	signal: AbortSignal | undefined,
) {
	try {
		return await observer?.observe({
			target,
			...(firstChangedLine === undefined ? {} : { firstChangedLine }),
			...(signal === undefined ? {} : { signal }),
		});
	} catch {
		return undefined;
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
