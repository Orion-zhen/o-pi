import { fail } from "./errors.js";
import type { FailedResult, FileToolErrorCode } from "./types.js";
import type { PermissionPromptContext } from "../permissions/permission-types.js";
import { PermissionService } from "../permissions/permission-service.js";
import { ResourceResolveError } from "../permissions/resource-resolver.js";

export interface FileToolPermissionRuntime {
	permissionService?: PermissionService;
	toolCallId?: string;
	promptContext?: PermissionPromptContext;
}

export function defaultPermissionService(workspaceRoot: string): PermissionService {
	return new PermissionService({ workspaceRoot, projectTrusted: false });
}

export function defaultPromptContext(): PermissionPromptContext {
	return {
		hasUI: false,
		timeoutMs: 120000,
		prompt: async () => ({ decision: "deny" }),
	};
}

export function permissionFailure(result: {
	code: FileToolErrorCode;
	message: string;
	resources: Array<{ action: string; path: string }>;
}): FailedResult {
	return fail(result.code, result.message, {
		details: {
			resources: result.resources,
			retry: "Do not retry the identical request unless the user changes policy or selects another path.",
		},
	});
}

export function pathResolveFailure(error: unknown): FailedResult | undefined {
	if (error instanceof ResourceResolveError) {
		return fail(error.code === "PATH_NOT_FOUND" ? "PATH_NOT_FOUND" : "INVALID_PATH", error.message, { path: error.inputPath });
	}
	if (typeof error === "object" && error !== null && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) {
		return fail("PERMISSION_DENIED", "Path cannot be accessed.");
	}
	return undefined;
}
