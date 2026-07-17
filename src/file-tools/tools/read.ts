import { fail, isFailed } from "../core/errors.js";
import { ignoreConfigFromFileTools, isIgnoredPath, loadFileToolsConfig, toolPathIdentity } from "../config.js";
import { defaultIgnoreEngine } from "../ignore/ignore-engine.js";
import { detectFileType, processInlineImage } from "../core/media-file.js";
import { resolveExistingFile, resolveWorkspaceRoot } from "../core/path-resolver.js";
import type { ReadVersionCache } from "../core/read-cache.js";
import { decodeTextFile, readRawFile, sha256Version, sliceTextByLineRange } from "../core/text-file.js";
import type { FileToolLspHooks, ReadFileSuccess, ReadImageSuccess, ReadParams, ReadSuccess, ToolOutcome } from "../types.js";
import type { RepoMapFileToolQuery } from "../../repo-map/file-tool-query.js";

const REPO_MAP_CONTEXT_LINES = 1;

export interface ReadRuntime {
	/** 会话内 read/edit 版本缓存，用于防止 stale edit。 */
	versionCache?: ReadVersionCache;
	/** 可选 LSP 增强；失败必须退化为普通 read。 */
	lsp?: FileToolLspHooks;
	/** 可选 Repo Map 上下文；实现方负责 activation、freshness 与实时 hash gate。 */
	repoMap?: Pick<RepoMapFileToolQuery, "readContext">;
}

/** read 读取 UTF-8 文本或模型可内联图片，不写入任何文件。 */
export async function readWorkspaceFile(cwd: string, params: ReadParams, runtime: ReadRuntime = {}): Promise<ToolOutcome<ReadFileSuccess>> {
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
	const ignoreSource = isIgnoredPath(config, toolPathIdentity(resolved.relativePath, resolved.absolutePath, resolved.workspacePath))
		? "file-tools.jsonc"
		: ignoreDecision.ignored
			? shortIgnoreSource(ignoreDecision.matchedRule?.sourceType)
			: undefined;

	const bytes = await readRawFile(resolved.realPath, resolved.relativePath);
	if (isFailed(bytes)) return bytes;
	const detected = await detectFileType(bytes);
	if (detected?.kind === "image") {
		if (params.start_line !== undefined || params.end_line !== undefined) {
			return fail("INVALID_OPERATION", "Line ranges apply only to text files.", { path: resolved.relativePath });
		}
		const image = await processInlineImage(bytes, detected.mime, resolved.relativePath);
		if (isFailed(image)) return image;
		const result: ReadImageSuccess = {
			path: resolved.relativePath,
			media_type: "image",
			mime_type: detected.mime,
			content: [`Read image file [${image.mimeType}]`, ...image.hints].join("\n"),
			size_bytes: bytes.byteLength,
			version: sha256Version(bytes),
			image: {
				data: image.data,
				mime_type: image.mimeType,
			},
			...(image.hints.length > 0 ? { hints: image.hints } : {}),
		};
		runtime.versionCache?.remember(resolved.realPath, result.version);
		applyIgnore(result, ignoreSource);
		return result;
	}
	if (detected !== undefined) {
		return fail("BINARY_FILE_UNSUPPORTED", `${detected.kind} files are not supported by read.`, {
			path: resolved.relativePath,
			details: { mime_type: detected.mime, extension: detected.ext },
		});
	}

	const file = decodeTextFile(bytes, resolved.relativePath);
	if (isFailed(file)) return file;
	runtime.versionCache?.remember(resolved.realPath, file.version);

	let sliced = sliceTextByLineRange(file, params.start_line, params.end_line, resolved.relativePath, {
		maxBytes: config.limits.read_bytes,
		maxLines: config.limits.read_lines,
	});
	if (isFailed(sliced)) return sliced;
	let repoMap = await safeRepoMapReadEnhancement(runtime.repoMap, {
		requestedPath: resolved.realPath,
		contentHash: file.version.replace(/^sha256:/u, ""),
		startLine: sliced.startLine,
		endLine: sliced.endLine,
		partial: params.start_line !== undefined || params.end_line !== undefined,
		truncated: sliced.truncated || sliced.continuation !== undefined,
	});
	if (repoMap !== undefined) {
		const contextBytes = Buffer.byteLength(JSON.stringify(repoMap), "utf8") * 6 + 128;
		if (contextBytes >= config.limits.read_bytes) repoMap = undefined;
		else {
			const budgeted = sliceTextByLineRange(file, params.start_line, params.end_line, resolved.relativePath, {
				maxBytes: Math.max(1, config.limits.read_bytes - contextBytes),
				maxLines: Math.max(1, config.limits.read_lines - REPO_MAP_CONTEXT_LINES),
			});
			if (!isFailed(budgeted)) sliced = budgeted;
		}
	}

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
	if (repoMap !== undefined) result.repo_map = repoMap;
	applyIgnore(result, ignoreSource);
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

async function safeRepoMapReadEnhancement(
	query: Pick<RepoMapFileToolQuery, "readContext"> | undefined,
	input: Parameters<RepoMapFileToolQuery["readContext"]>[0],
): Promise<ReadSuccess["repo_map"] | undefined> {
	try {
		return await query?.readContext(input);
	} catch {
		return undefined;
	}
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

function applyIgnore(result: ReadFileSuccess, ignoreSource: string | undefined): void {
	if (ignoreSource === undefined) return;
	result.ignored = true;
	result.ignore_source = ignoreSource;
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
