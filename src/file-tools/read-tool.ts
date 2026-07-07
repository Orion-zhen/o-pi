import { fail, isFailed } from "./errors.js";
import { ignoreConfigFromFileTools, isIgnoredPath, loadFileToolsConfig, toolPathIdentity } from "./config.js";
import { defaultIgnoreEngine } from "./ignore/ignore-engine.js";
import { resolveExistingFile, resolveWorkspaceRoot } from "./path-resolver.js";
import type { ReadVersionCache } from "./read-cache.js";
import { readTextFile, sliceTextByLineRange } from "./text-file.js";
import type { FileToolLspHooks, ReadParams, ReadSuccess, ToolOutcome } from "./types.js";

export interface ReadRuntime {
	/** 会话内 read/edit 版本缓存，用于防止 stale edit。 */
	versionCache?: ReadVersionCache;
	/** 可选 LSP 增强；失败必须退化为普通 read。 */
	lsp?: FileToolLspHooks;
}

/** read 读取 UTF-8 文本、行范围、版本和换行元数据，不写入任何文件。 */
export async function readWorkspaceFile(cwd: string, params: ReadParams, runtime: ReadRuntime = {}): Promise<ToolOutcome<ReadSuccess>> {
	const config = await loadFileToolsConfig();
	if (isFailed(config)) return config;
	const workspaceRoot = await resolveWorkspaceRoot(cwd);
	const rangeError = validateRangeSyntax(params, params.path);
	if (rangeError) return rangeError;
	const resolved = await resolveExistingFile(workspaceRoot, params.path, config);
	if (isFailed(resolved)) return resolved;
	const ignoreSnapshot = await defaultIgnoreEngine.createSnapshot(workspaceRoot, ignoreConfigFromFileTools(config));
	const ignoreDecision = resolved.workspacePath !== undefined
		? ignoreSnapshot.evaluate({ path: resolved.workspacePath, kind: "file", intent: "explicit-read" })
		: { ignored: false, matchedRule: undefined };

	const file = await readTextFile(resolved.realPath, resolved.relativePath);
	if (isFailed(file)) return file;
	runtime.versionCache?.remember(resolved.realPath, file.version);

	const sliced = sliceTextByLineRange(file, params.start_line, params.end_line, resolved.relativePath, {
		maxBytes: config.limits.read_bytes,
		maxLines: config.limits.read_lines,
	});
	if (isFailed(sliced)) return sliced;

	const result: ReadSuccess = {
		path: resolved.relativePath,
		content: sliced.content,
		start_line: sliced.startLine,
		end_line: sliced.endLine,
		total_lines: file.totalLines,
		size_bytes: file.sizeBytes,
		version: file.version,
		encoding: "utf-8",
		newline: file.newline,
		truncated: sliced.truncated,
		...(sliced.continuation ? { continuation: sliced.continuation } : {}),
		bom: file.hasBom,
	};
	if (isIgnoredPath(config, toolPathIdentity(resolved.relativePath, resolved.absolutePath, resolved.workspacePath))) {
		result.ignored = true;
		result.ignore_source = "file-tools.jsonc";
	} else if (ignoreDecision.ignored) {
		result.ignored = true;
		const source = shortIgnoreSource(ignoreDecision.matchedRule?.sourceType);
		if (source !== undefined) result.ignore_source = source;
	}
	const lsp = await safeReadEnhancement(runtime.lsp, {
		workspaceRoot,
		absolutePath: resolved.realPath,
		relativePath: resolved.relativePath,
		content: file.text,
		start_line: result.start_line,
		end_line: result.end_line,
		truncated: result.truncated || result.continuation !== undefined,
		partial: params.start_line !== undefined || params.end_line !== undefined,
	});
	if (lsp !== undefined) result.lsp = lsp;
	return result;
}

async function safeReadEnhancement(
	hooks: FileToolLspHooks | undefined,
	input: Parameters<NonNullable<FileToolLspHooks["enhanceRead"]>>[0],
): Promise<ReadSuccess["lsp"] | undefined> {
	if (!input.partial && !input.truncated) return undefined;
	try {
		return await hooks?.enhanceRead?.(input);
	} catch {
		return undefined;
	}
}

function shortIgnoreSource(sourceType: string | undefined): string | undefined {
	if (sourceType === "piignore") return ".piignore";
	if (sourceType === "gitignore") return ".gitignore";
	if (sourceType === "git-info-exclude") return ".git/info/exclude";
	return sourceType;
}

function validateRangeSyntax(params: ReadParams, path: string): ToolOutcome<never> | undefined {
	if (params.start_line !== undefined && (!Number.isInteger(params.start_line) || params.start_line < 1)) {
		return {
			status: "failed",
			error: { code: "INVALID_PATH", message: "start_line must be a positive integer.", path },
		};
	}
	if (params.end_line !== undefined && (!Number.isInteger(params.end_line) || params.end_line < 1)) {
		return {
			status: "failed",
			error: { code: "INVALID_PATH", message: "end_line must be a positive integer.", path },
		};
	}
	if (params.start_line !== undefined && params.end_line !== undefined && params.start_line > params.end_line) {
		return {
			status: "failed",
			error: { code: "INVALID_PATH", message: "start_line must be less than or equal to end_line.", path },
		};
	}
	return undefined;
}
