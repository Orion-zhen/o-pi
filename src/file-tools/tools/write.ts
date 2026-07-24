import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateDiffString, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { guardWritablePath, PathGuardBlockedError } from "../../safety/path-guard.js";
import { loadFileToolsConfig } from "../config.js";
import { fail, isAccessDenied, isFailed, protectedPathFailure } from "../core/errors.js";
import { normalizeToolPath, resolveWorkspaceRoot } from "../core/path-resolver.js";
import type { ReadVersionCache } from "../core/read-cache.js";
import { normalizeLineEndings, sha256Version } from "../core/text-file.js";
import type { FileToolLspHooks, LspDiagnosticsSummary, ToolOutcome, WriteParams, WriteSuccess } from "../types.js";

interface WritablePath {
	relativePath: string;
	absolutePath: string;
	workspacePath?: string;
}

export interface WriteRuntime {
	/** 会话内 read/edit 版本缓存；写入成功后允许直接 edit。 */
	versionCache?: ReadVersionCache;
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
		if (error instanceof PathGuardBlockedError) return protectedPathFailure(target.relativePath, error.block);
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
		await rememberWrittenVersion(runtime.versionCache, target.absolutePath, diff.afterVersion);

		const result: WriteSuccess = {
			status: "written",
			path: target.relativePath,
			bytes: Buffer.byteLength(input.content, "utf8"),
			action: diff.existed ? "modify" : "create",
			...(diff.beforeVersion === undefined ? {} : { before_version: diff.beforeVersion }),
			after_version: diff.afterVersion,
			...(diff.beforeSizeBytes === undefined ? {} : { before_size_bytes: diff.beforeSizeBytes }),
			after_size_bytes: diff.afterSizeBytes,
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

async function buildWriteDiff(absolutePath: string, newText: string): Promise<{
	diff: string;
	firstChangedLine?: number;
	existed: boolean;
	beforeVersion?: string;
	afterVersion: string;
	beforeSizeBytes?: number;
	afterSizeBytes: number;
}> {
	let oldBytes: Buffer | undefined;
	let existed = false;
	try {
		oldBytes = await readFile(absolutePath);
		existed = true;
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") existed = await pathExists(absolutePath);
	}
	const oldText = oldBytes?.toString("utf8") ?? "";
	const newBytes = Buffer.from(newText, "utf8");
	const result = generateDiffString(normalizeLineEndings(oldText), normalizeLineEndings(newText));
	return {
		diff: result.diff,
		existed,
		...(oldBytes === undefined ? {} : { beforeVersion: sha256Version(oldBytes), beforeSizeBytes: oldBytes.byteLength }),
		afterVersion: sha256Version(newBytes),
		afterSizeBytes: newBytes.byteLength,
		...(result.firstChangedLine !== undefined ? { firstChangedLine: result.firstChangedLine } : {}),
	};
}

async function rememberWrittenVersion(cache: ReadVersionCache | undefined, absolutePath: string, version: string): Promise<void> {
	if (cache === undefined) return;
	try {
		cache.remember(await realpath(absolutePath), version);
	} catch {
		// 写入已成功；并发删除只会让下一次 edit 重新要求 read。
	}
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error;
}

async function pathExists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
}
