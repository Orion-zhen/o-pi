import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateDiffString, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { guardWritablePath, PathGuardBlockedError } from "../../safety/path-guard.js";
import { loadFileToolsConfig } from "../config.js";
import { fail, isFailed } from "../core/errors.js";
import { normalizeToolPath, resolveWorkspaceRoot } from "../core/path-resolver.js";
import type { FailedResult, FileToolLspHooks, LspDiagnosticsSummary, ToolOutcome, WriteParams, WriteSuccess } from "../types.js";

interface WritablePath {
	relativePath: string;
	absolutePath: string;
	workspacePath?: string;
}

export interface WriteRuntime {
	/** 可选 LSP 增强；失败必须退化为普通 write。 */
	lsp?: FileToolLspHooks;
}

/** write 复刻 Pi 内置 write：创建父目录，并用 UTF-8 内容创建或覆盖单个文件。 */
export async function writeWorkspaceFile(cwd: string, params: unknown, signal?: AbortSignal, runtime: WriteRuntime = {}): Promise<ToolOutcome<WriteSuccess>> {
	const input = validateWriteInput(params);
	if (isFailed(input)) return input;

	const config = await loadFileToolsConfig();
	if (isFailed(config)) return config;
	const workspaceRoot = await resolveWorkspaceRoot(cwd);
	const target = resolveWritablePath(workspaceRoot, input.path);
	if (isFailed(target)) return target;

	try {
		await guardWritablePath(input.path, { cwd: workspaceRoot, blocked_path: config.blocked_path });
	} catch (error) {
		if (error instanceof PathGuardBlockedError) return blockedPathFailure(target.relativePath, error);
		if (isAccessDenied(error)) return fail("ACCESS_DENIED", "Parent path cannot be accessed.", { path: target.relativePath });
		return fail("INVALID_PATH", "Parent path cannot be resolved.", { path: target.relativePath });
	}

	return withFileMutationQueue(target.absolutePath, async () => {
		const aborted = checkAbort(signal);
		if (aborted) return aborted;
		try {
			await mkdir(path.dirname(target.absolutePath), { recursive: true });
		} catch {
			return fail("INVALID_PATH", "Parent path cannot be created.", { path: target.relativePath });
		}

		const abortedAfterMkdir = checkAbort(signal);
		if (abortedAfterMkdir) return abortedAfterMkdir;
		const diff = await buildWriteDiff(target.absolutePath, input.content);
		const abortedAfterDiff = checkAbort(signal);
		if (abortedAfterDiff) return abortedAfterDiff;
		try {
			await writeFile(target.absolutePath, input.content, "utf8");
		} catch {
			return fail("ACCESS_DENIED", "File could not be written.", { path: target.relativePath });
		}

		const abortedAfterWrite = checkAbort(signal);
		if (abortedAfterWrite) return abortedAfterWrite;
		const result: WriteSuccess = {
			status: "written",
			path: target.relativePath,
			bytes: Buffer.byteLength(input.content, "utf8"),
			diff: diff.diff,
			...(diff.firstChangedLine !== undefined ? { firstChangedLine: diff.firstChangedLine } : {}),
		};
		const diagnostics = await safeAfterWrite(runtime.lsp, {
			workspaceRoot,
			path: target.relativePath,
			absolutePath: target.absolutePath,
			content: input.content,
		});
		if (diagnostics !== undefined) result.lsp = { diagnostics };
		return result;
	});
}

async function buildWriteDiff(absolutePath: string, newText: string): Promise<{ diff: string; firstChangedLine?: number }> {
	let oldText = "";
	try {
		oldText = await readFile(absolutePath, "utf8");
	} catch {
		oldText = "";
	}
	const result = generateDiffString(normalizeLineEndings(oldText), normalizeLineEndings(newText));
	return {
		diff: result.diff,
		...(result.firstChangedLine !== undefined ? { firstChangedLine: result.firstChangedLine } : {}),
	};
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

async function safeAfterWrite(
	hooks: FileToolLspHooks | undefined,
	input: Parameters<NonNullable<FileToolLspHooks["afterWrite"]>>[0],
): Promise<LspDiagnosticsSummary | undefined> {
	try {
		return await hooks?.afterWrite?.(input);
	} catch {
		return undefined;
	}
}

function validateWriteInput(params: unknown): ToolOutcome<WriteParams> {
	if (!isPlainRecord(params)) {
		return fail("INVALID_OPERATION", "write input must be an object.");
	}
	const allowed = new Set(["path", "content"]);
	for (const key of Object.keys(params)) {
		if (!allowed.has(key)) {
			return fail("INVALID_OPERATION", `Unsupported write field: ${key}.`, { details: { field: key } });
		}
	}
	if (typeof params["path"] !== "string") {
		return fail("INVALID_OPERATION", "path must be a string.");
	}
	if (typeof params["content"] !== "string") {
		return fail("INVALID_OPERATION", "content must be a string.");
	}
	return { path: params["path"], content: params["content"] };
}

function resolveWritablePath(workspaceRoot: string, inputPath: string): ToolOutcome<WritablePath> {
	const target = normalizeToolPath(workspaceRoot, inputPath);
	if (isFailed(target)) return target;
	if (target.workspacePath === ".") {
		return fail("INVALID_PATH", "Target must be a file path, not the current directory.", { path: inputPath });
	}
	return target;
}

function checkAbort(signal: AbortSignal | undefined): ToolOutcome<never> | undefined {
	return signal?.aborted === true ? fail("OPERATION_ABORTED", "Operation aborted.") : undefined;
}

function blockedPathFailure(displayPath: string, error: PathGuardBlockedError): FailedResult {
	return fail("PROTECTED_PATH", error.block.message, {
		path: displayPath,
		details: {
			code: error.block.code,
			...(error.block.matched_rule !== undefined ? { matched_rule: error.block.matched_rule } : {}),
			...(error.block.matched_path !== undefined ? { matched_path: error.block.matched_path } : {}),
		},
	});
}

function isAccessDenied(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
