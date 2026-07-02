/** 文件系统内部动作；策略文件不暴露这些细节。 */
export type PermissionAction =
	| "fs.list"
	| "fs.read"
	| "fs.create"
	| "fs.update"
	| "fs.replace"
	| "fs.delete"
	| "fs.move";

/** 权限策略的三态结果。 */
export type PermissionEffect = "allow" | "ask" | "deny";

/** 资源边界由 canonical path 决定，不能由模型声明。 */
export type ResourceBoundary = "workspace" | "external" | "system" | "sensitive";

/** 权限运行模式；yolo 只把普通 ask 视为 allow。 */
export type PermissionMode = "safe" | "read-only" | "yolo";

export type PermissionTargetType = "file" | "directory" | "symlink" | "missing" | "other";

/** 用户配置面向工具名，不要求知道内部 fs.* 动作。 */
export type PermissionToolName = "ls" | "read" | "edit";

export type PermissionErrorCode =
	| "PERMISSION_DENIED"
	| "PERMISSION_DENIED_BY_USER"
	| "PERMISSION_PROMPT_UNAVAILABLE"
	| "PERMISSION_PROMPT_TIMEOUT"
	| "PERMISSION_CONTEXT_CHANGED"
	| "PERMISSION_POLICY_INVALID"
	| "PERMISSION_POLICY_LOAD_FAILED"
	| "PERMISSION_POLICY_WRITE_FAILED"
	| "PERMISSION_PROTECTED_RESOURCE"
	| "PERMISSION_UNKNOWN_ACTION"
	| "PERMISSION_UNKNOWN_TOOL"
	| "PERMISSION_EXTRACTOR_FAILED"
	| "PERMISSION_INTERNAL_ERROR";

export interface FileIdentity {
	device?: number;
	inode?: number;
}

/** 已解析路径，既保留用户写法，也保留真实 canonical 目标。 */
export interface ResolvedPermissionPath {
	inputPath: string;
	absolutePath: string;
	canonicalPath: string;
	workspaceRelativePath?: string;
	boundary: ResourceBoundary;
	exists: boolean;
	type: PermissionTargetType;
	viaSymlink: boolean;
	symlinkChain: string[];
	identity?: FileIdentity;
	canonicalParentPath?: string;
	canonicalParentIdentity?: FileIdentity;
}

/** 单次工具调用中的一个真实资源访问。 */
export interface PermissionAccess {
	action: PermissionAction;
	inputPath: string;
	absolutePath: string;
	canonicalPath: string;
	displayPath: string;
	boundary: ResourceBoundary;
	targetType: PermissionTargetType;
	exists: boolean;
	viaSymlink: boolean;
	sourcePath?: string;
	destinationPath?: string;
	identity?: FileIdentity;
	canonicalParentIdentity?: FileIdentity;
}

export interface PermissionRequest {
	requestId: string;
	toolCallId: string;
	toolName: string;
	accesses: PermissionAccess[];
	risk: "low" | "medium" | "high" | "critical";
	normalizedInputFingerprint: string;
	policyGeneration: number;
	normalizedToolInput?: unknown;
}

export type PermissionRuleTool = PermissionToolName | "*";

export interface PermissionBoundaryDefaults {
	workspace?: Partial<Record<PermissionRuleTool, PermissionEffect>>;
	external?: Partial<Record<PermissionRuleTool, PermissionEffect>>;
	system?: Partial<Record<PermissionRuleTool, PermissionEffect>>;
	sensitive?: Partial<Record<PermissionRuleTool, PermissionEffect>>;
}

export type PermissionResourceSelector =
	| { type: "path"; path: string; scope: "exact" | "subtree" }
	| { type: "boundary"; boundary: ResourceBoundary };

export interface PermissionRule {
	id: string;
	description?: string;
	effect: PermissionEffect;
	resource: PermissionResourceSelector;
	tools: PermissionRuleTool[];
}

export interface PermissionPolicyFile {
	version: 1;
	/** 顶层工具门禁；只按注册工具名生效，路径资源仍由 defaults/rules 判断。 */
	tools?: Record<string, PermissionEffect>;
	defaults?: PermissionBoundaryDefaults;
	rules?: PermissionRule[];
}

export interface LoadedPermissionPolicy {
	source: "global" | "project";
	path: string;
	status: "missing" | "loaded" | "invalid" | "load_failed" | "untrusted";
	policy?: PermissionPolicyFile;
	error?: string;
}

export interface PolicyTraceEntry {
	effect: PermissionEffect;
	source: "builtin" | "global" | "project" | "session" | "default" | "mode";
	ruleId?: string;
	sourcePath?: string;
	reason: string;
}

export interface PolicyEvaluation {
	effect: PermissionEffect;
	matchedRule?: {
		id: string;
		source: "builtin" | "global" | "project" | "session";
		sourcePath?: string;
		index?: number;
	};
	trace?: PolicyTraceEntry[];
	reason: string;
	denyFloor: boolean;
}

export interface SessionGrant {
	id: string;
	actions: PermissionAction[];
	resource: {
		canonicalPath: string;
		scope: "exact" | "subtree";
	};
	lifetime: "once" | "session";
	createdAt: number;
	origin: {
		toolCallId: string;
		requestFingerprint: string;
	};
	rootIdentity?: FileIdentity;
}

export interface UserPermissionDecision {
	decision: "allow-once" | "allow-session-exact" | "allow-session-subtree" | "deny";
}

export interface PermissionPromptContext {
	hasUI: boolean;
	timeoutMs: number;
	prompt(request: PermissionRequest, evaluation: PolicyEvaluation): Promise<UserPermissionDecision>;
}

export interface PermissionAuditEntry {
	timestamp: string;
	sessionId?: string;
	requestId: string;
	toolCallId: string;
	toolName: string;
	fingerprint: string;
	policyGeneration: number;
	accesses: Array<{
		action: PermissionAction;
		canonicalPath: string;
		boundary: ResourceBoundary;
	}>;
	policyEffect: PermissionEffect;
	finalDecision: "allowed" | "denied";
	decisionSource:
		| "builtin"
		| "global-rule"
		| "project-rule"
		| "session-grant"
		| "user"
		| "mode"
		| "no-ui"
		| "error";
	matchedRuleId?: string;
	errorCode?: PermissionErrorCode;
}

export interface PermissionServiceStatus {
	mode: PermissionMode;
	globalPolicy: LoadedPermissionPolicy;
	projectPolicy: LoadedPermissionPolicy;
	projectTrusted: boolean;
	policyGeneration: number;
	sessionGrantCount: number;
	recentErrors: string[];
	auditEnabled: boolean;
}

export const permissionActions: readonly PermissionAction[] = [
	"fs.list",
	"fs.read",
	"fs.create",
	"fs.update",
	"fs.replace",
	"fs.delete",
	"fs.move",
] as const;

export const permissionToolNames: readonly PermissionToolName[] = ["ls", "read", "edit"] as const;

export const permissionEffects: readonly PermissionEffect[] = ["allow", "ask", "deny"] as const;

export const resourceBoundaries: readonly ResourceBoundary[] = ["workspace", "external", "system", "sensitive"] as const;

export function isWriteAction(action: PermissionAction): boolean {
	return action !== "fs.list" && action !== "fs.read";
}
