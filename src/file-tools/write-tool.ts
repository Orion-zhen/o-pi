import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { isBlockedPath, loadFileToolsConfig, toolPathIdentity } from "./config.js";
import { fail, isFailed } from "./errors.js";
import { normalizeToolPath, resolveWorkspaceRoot } from "./path-resolver.js";
import type { FileToolLspHooks, LspDiagnosticsSummary, ToolOutcome, WriteParams, WriteSuccess } from "./types.js";

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
	if (isBlockedPath(config, toolPathIdentity(target.relativePath, target.absolutePath, target.workspacePath))) {
		return fail("PROTECTED_PATH", "Path is blocked by file-tools config.", { path: target.relativePath });
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
