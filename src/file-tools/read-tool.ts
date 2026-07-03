import { fail, isFailed } from "./errors.js";
import { defaultIgnoreEngine } from "./ignore/ignore-engine.js";
import {
	defaultPermissionService,
	defaultPromptContext,
	permissionFailure,
	type FileToolPermissionRuntime,
} from "./permission-runtime.js";
import { resolveExistingFile, resolveWorkspaceRoot } from "./path-security.js";
import { readTextFile, sliceTextByLineRange } from "./text-file.js";
import type { ReadParams, ReadSuccess, ToolOutcome } from "./types.js";

/** read 按权限读取 UTF-8 文本、行范围、版本和换行元数据，不写入任何文件。 */
export async function readWorkspaceFile(
	cwd: string,
	params: ReadParams,
	runtime: FileToolPermissionRuntime = {},
): Promise<ToolOutcome<ReadSuccess>> {
	const workspaceRoot = await resolveWorkspaceRoot(cwd);
	const rangeError = validateRangeSyntax(params, params.path);
	if (rangeError) return rangeError;
	const permissionService = runtime.permissionService ?? defaultPermissionService(workspaceRoot);
	const authorization = await permissionService.authorizeSubjectCall({
		kind: "tool",
		configKey: "read",
		input: params,
		executionId: runtime.toolCallId ?? "direct-read",
		promptContext: runtime.promptContext ?? defaultPromptContext(),
		consumeLease: true,
	});
	if (!authorization.allowed) return permissionFailure({ code: authorization.error.code, message: authorization.error.message, resources: [] });
	if (!(await permissionService.verifySubjectRequestUnchanged(authorization.request, { kind: "tool", configKey: "read", input: params }))) {
		return fail("PERMISSION_CONTEXT_CHANGED", "Permission context changed before reading.", { path: params.path });
	}
	const resolved = await resolveExistingFile(workspaceRoot, params.path);
	if (isFailed(resolved)) return resolved;
	const ignoreSnapshot = await defaultIgnoreEngine.createSnapshot(workspaceRoot);
	const workspacePath = isWorkspaceRelative(resolved.relativePath);
	const ignoreDecision = workspacePath
		? ignoreSnapshot.evaluate({ path: resolved.relativePath, kind: "file", intent: "explicit-read" })
		: { ignored: false, matchedRule: undefined };

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

function isWorkspaceRelative(value: string): boolean {
	return value === "." || (!value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value));
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
