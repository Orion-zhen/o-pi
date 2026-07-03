import { fail } from "./errors.js";
import os from "node:os";
import path from "node:path";
import type { FailedResult, FileToolErrorCode } from "./types.js";
import type { ApprovalPromptContext } from "../security/approval/approval.js";
import { SecurityService } from "../security/runtime/security-service.js";
import { FileResolveError } from "../security/runtime/file-resolver.js";
import type { PrincipalContext } from "../security/model/types.js";

export interface FileToolPermissionRuntime {
	securityService?: SecurityService;
	toolCallId?: string;
	promptContext?: ApprovalPromptContext;
	principal?: PrincipalContext;
}

export function defaultSecurityService(workspaceRoot: string): SecurityService {
	return new SecurityService({ workspaceRoot, agentDir: path.join(os.tmpdir(), "o-pi-agent"), projectTrusted: false });
}

export function defaultPromptContext(): ApprovalPromptContext {
	return {
		hasUI: false,
		timeoutMs: 120000,
		prompt: async () => "deny",
	};
}

export function permissionFailure(result: {
	code: FileToolErrorCode | string;
	message: string;
	resources: Array<{ action: string; path: string }>;
}): FailedResult {
	const code =
		result.code === "PERMISSION_ANALYSIS_FAILED" || result.code === "SECURITY_ANALYSIS_FAILED" ? "INVALID_PATH" : result.code;
	return fail(code as FileToolErrorCode, result.message, {
		details: {
			resources: result.resources,
			retry: "Do not retry the identical request unless the user changes policy or selects another path.",
		},
	});
}

export function pathResolveFailure(error: unknown): FailedResult | undefined {
	if (error instanceof FileResolveError) {
		return fail(error.code === "PATH_NOT_FOUND" ? "PATH_NOT_FOUND" : "INVALID_PATH", error.message, { path: error.inputPath });
	}
	if (typeof error === "object" && error !== null && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) {
		return fail("PERMISSION_DENIED", "Path cannot be accessed.");
	}
	return undefined;
}
