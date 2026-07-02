import { isFailed } from "./errors.js";
import { defaultIgnoreEngine } from "./ignore/ignore-engine.js";
import { resolveExistingFile, resolveWorkspaceRoot } from "./path-security.js";
import { readTextFile, sliceTextByLineRange } from "./text-file.js";
import type { ReadParams, ReadSuccess, ToolOutcome } from "./types.js";

/** read 只观察工作区：读取 UTF-8 文本、行范围、版本和换行元数据，不写入任何文件。 */
export async function readWorkspaceFile(cwd: string, params: ReadParams): Promise<ToolOutcome<ReadSuccess>> {
	const workspaceRoot = await resolveWorkspaceRoot(cwd);
	const resolved = await resolveExistingFile(workspaceRoot, params.path);
	if (isFailed(resolved)) return resolved;
	const ignoreSnapshot = await defaultIgnoreEngine.createSnapshot(workspaceRoot);
	const ignoreDecision = ignoreSnapshot.evaluate({ path: resolved.relativePath, kind: "file", intent: "explicit-read" });
	const rangeError = validateRangeSyntax(params, resolved.relativePath);
	if (rangeError) return rangeError;

	const file = await readTextFile(resolved.realPath, resolved.relativePath);
	if (isFailed(file)) return file;

	const sliced = sliceTextByLineRange(file, params.start_line, params.end_line, resolved.relativePath);
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
	if (ignoreDecision.ignored) {
		result.ignored = true;
		const source = shortIgnoreSource(ignoreDecision.matchedRule?.sourceType);
		if (source !== undefined) result.ignore_source = source;
	}
	return result;
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
