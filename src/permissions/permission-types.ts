/** 用户策略可表达的三态效果。 */
export type PermissionEffect = "allow" | "ask" | "deny";

/** 内部求值使用的完整效果；policy-error 与 hard-deny 不可被覆盖。 */
export type CompiledEffect = PermissionEffect | "no-opinion" | "policy-error" | "hard-deny";

/** 会话 profile；unrestricted 只把普通 ask 降为 allow。 */
export type PermissionProfile = "cautious" | "standard" | "read-only" | "unrestricted";

/** 所有受控对象共享的主体类型。 */
export type PermissionSubjectKind = "tool" | "mcp-tool" | "skill" | "agent";

/** 稳定主体 ID，持久授权绑定该 ID 与来源 identity。 */
export type PermissionSubjectId = string;

/** 内部能力模型；用户配置不直接暴露这些操作名。 */
export type PermissionOperation =
	| "file.list"
	| "file.read"
	| "file.create"
	| "file.update"
	| "file.replace"
	| "file.delete"
	| "file.move"
	| "process.execute"
	| "mcp.invoke"
	| "skill.load"
	| "agent.spawn";

export type FileAccess = "read" | "write";
export type FileRootAccess = "read-only" | "read-write";

/** 文件 identity 在不支持 dev/ino 的平台允许为空，比较时会降级到路径与父目录校验。 */
export interface FileIdentity {
	device?: number;
	inode?: number;
}

export type FileNodeType = "file" | "directory" | "symlink" | "other";

/** 文件资源解析结果同时保留词法路径与 canonical target。 */
export interface ResolvedFileResource {
	kind: "file";
	inputPath: string;
	lexicalAbsolutePath: string;
	canonicalPath: string;
	lexicalType: FileNodeType;
	targetType: Exclude<FileNodeType, "symlink">;
	exists: boolean;
	viaSymlink: boolean;
	symlinkChain: string[];
	identity?: FileIdentity;
	canonicalParentPath?: string;
	canonicalParentIdentity?: FileIdentity;
	displayPath: string;
	access: FileAccess;
	operation: PermissionOperation;
}

export interface CommandResource {
	kind: "command";
	command: string;
}

export interface McpResource {
	kind: "mcp";
	server: string;
	tool: string;
}

export interface SkillResource {
	kind: "skill";
	name: string;
}

export interface AgentResource {
	kind: "agent";
	name: string;
}

export interface OpaqueResource {
	kind: "opaque";
	label: string;
}

export type PermissionResource = ResolvedFileResource | CommandResource | McpResource | SkillResource | AgentResource | OpaqueResource;

/** 授权主体，来自注册表而不是工具名字符串临时拼接。 */
export interface PermissionSubject {
	id: PermissionSubjectId;
	kind: PermissionSubjectKind;
	configKey: string;
	displayName: string;
	source: {
		type: "builtin" | "extension" | "mcp" | "skill" | "agent";
		name: string;
		identity?: string;
	};
}

export interface PermissionAnalysisContext {
	workspaceRoot: string;
	agentDir: string;
	signal?: AbortSignal;
}

/** descriptor 只描述意图，不能自行作出 allow 决策。 */
export interface PermissionIntent {
	operations: PermissionOperation[];
	resources: PermissionResource[];
	summary: string;
	details?: string[];
}

export interface ApprovalScopeSuggestion {
	id: string;
	label: string;
	scope: "once" | "session-exact" | "session-subtree" | "always";
}

export interface PermissionSubjectDescriptor<TInput = unknown> extends PermissionSubject {
	analyze(input: TInput, context: PermissionAnalysisContext): Promise<PermissionIntent>;
	suggestScopes?(intent: PermissionIntent): ApprovalScopeSuggestion[];
}

export interface AuthorizationRequest {
	requestId: string;
	toolCallId?: string;
	subject: PermissionSubject;
	inputFingerprint: string;
	operations: PermissionOperation[];
	resources: PermissionResource[];
	summary: string;
	details?: string[];
	policyGeneration: number;
}

export type PermissionErrorCode =
	| "PERMISSION_DENIED"
	| "PERMISSION_HARD_DENIED"
	| "PERMISSION_POLICY_INVALID"
	| "PERMISSION_POLICY_LOAD_FAILED"
	| "PERMISSION_UNKNOWN_SUBJECT"
	| "PERMISSION_COMMAND_PARSE_ERROR"
	| "PERMISSION_COMMAND_UNKNOWN"
	| "PERMISSION_COMMAND_INVALID_ARGUMENT"
	| "PERMISSION_COMMAND_AMBIGUOUS_SUBJECT"
	| "PERMISSION_COMMAND_UI_REQUIRED"
	| "PERMISSION_POLICY_CONFLICT"
	| "PERMISSION_ROOT_NOT_FOUND"
	| "PERMISSION_GRANT_NOT_FOUND"
	| "PERMISSION_OPERATION_CANCELLED"
	| "PERMISSION_ANALYSIS_FAILED"
	| "PERMISSION_PROMPT_UNAVAILABLE"
	| "PERMISSION_PROMPT_TIMEOUT"
	| "PERMISSION_PROMPT_CANCELLED"
	| "PERMISSION_INPUT_CHANGED"
	| "PERMISSION_RESOURCE_CHANGED"
	| "PERMISSION_LEASE_MISSING"
	| "PERMISSION_LEASE_INVALID"
	| "PERMISSION_LEASE_CONSUMED"
	| "PERMISSION_SUBJECT_IDENTITY_CHANGED"
	| "PERMISSION_PERSISTENCE_FAILED"
	| "PERMISSION_INTERNAL_ERROR";

/** 面向工具和模型的结构化错误。 */
export interface PermissionError {
	code: PermissionErrorCode;
	message: string;
	retry?: "never" | "after-policy-change";
}

/** 一次性执行凭证；审批和执行之间用它固定输入、资源和 generation。 */
export interface AuthorizationLease {
	id: string;
	requestId: string;
	toolCallId?: string;
	subjectId: string;
	subjectIdentity?: string;
	inputFingerprint: string;
	resourceFingerprints: string[];
	policyGeneration: number;
	createdAt: number;
	consumed: boolean;
}

export interface DecisionTraceEntry {
	source:
		| "hard-protection"
		| "policy-error"
		| "profile"
		| "global-policy"
		| "project-policy"
		| "persistent-grant"
		| "session-grant"
		| "user"
		| "no-ui";
	effect: CompiledEffect;
	message: string;
	ruleId?: string;
}

export interface CompiledDecision {
	effect: CompiledEffect;
	finalEffect: "allow" | "ask" | "deny";
	source: DecisionTraceEntry["source"];
	trace: DecisionTraceEntry[];
	ruleId?: string;
	grantIds?: string[];
}

export type AuthorizationResult =
	| { allowed: true; lease: AuthorizationLease; decision: CompiledDecision; request: AuthorizationRequest }
	| { allowed: false; error: PermissionError; decision?: CompiledDecision; request?: AuthorizationRequest };

export interface UserPermissionDecision {
	decision: "allow-once" | "allow-session-exact" | "allow-session-subtree" | "always-allow" | "deny";
}

export interface PermissionPromptContext {
	hasUI: boolean;
	timeoutMs: number;
	signal?: AbortSignal;
	prompt(request: AuthorizationRequest, decision: CompiledDecision): Promise<UserPermissionDecision>;
}

export interface FileRootGrant {
	canonicalPath: string;
	access: FileRootAccess;
	source: "profile" | "global-config" | "session" | "persistent";
}

export interface PolicyDiagnostic {
	file: string;
	pointer: string;
	line: number;
	column: number;
	message: string;
}

export interface LoadedPolicy {
	source: "global" | "project";
	path: string;
	status: "missing" | "loaded" | "invalid" | "load_failed" | "untrusted";
	diagnostics: PolicyDiagnostic[];
	config?: PermissionConfig;
}

export interface PolicySnapshot {
	generation: number;
	valid: boolean;
	global: LoadedPolicy;
	project: LoadedPolicy;
	profile: PermissionProfile;
	roots: FileRootGrant[];
	globalConfig?: PermissionConfig;
	projectConfig?: PermissionConfig;
	diagnostics: PolicyDiagnostic[];
	auditEnabled: boolean;
}

export interface PermissionServiceStatus {
	profile: PermissionProfile;
	globalPolicy: LoadedPolicy;
	projectPolicy: LoadedPolicy;
	projectTrusted: boolean;
	policyGeneration: number;
	registryGeneration: number;
	sessionGrantCount: number;
	persistentGrantCount: number;
	maintenance: boolean;
	auditEnabled: boolean;
	recentErrors: string[];
}

export interface PermissionAuditEntry {
	timestamp: string;
	sessionId?: string;
	requestId: string;
	toolCallId?: string;
	subject: {
		id: string;
		configKey: string;
		kind: string;
		source: string;
		identity?: string;
	};
	inputFingerprint: string;
	policyGeneration: number;
	registryGeneration: number;
	operations: string[];
	resources: SanitizedAuditResource[];
	policyEffect: "allow" | "ask" | "deny" | "hard-deny" | "policy-error";
	finalDecision: "allowed" | "denied";
	decisionSource:
		| "profile"
		| "global-policy"
		| "project-policy"
		| "persistent-grant"
		| "session-grant"
		| "user"
		| "hard-protection"
		| "policy-error"
		| "no-ui"
		| "timeout"
		| "cancelled"
		| "runtime-error";
	ruleId?: string;
	grantIds?: string[];
	leaseId?: string;
	errorCode?: string;
}

export type SanitizedAuditResource =
	| { kind: "file"; access: FileAccess; operation: PermissionOperation; path: string; exists: boolean; viaSymlink: boolean }
	| { kind: "command"; commandPattern: string }
	| { kind: "mcp"; server: string; tool: string }
	| { kind: "skill"; name: string }
	| { kind: "agent"; name: string }
	| { kind: "opaque"; label: string };

export interface PermissionConfig {
	$schema?: string;
	version: 1;
	profile?: PermissionProfile;
	files?: {
		roots?: Array<{ path: string; access: FileRootAccess }>;
		outsideRoots?: Partial<Record<FileAccess, PermissionEffect>>;
		rules?: EffectRules<FileRule>;
	};
	tools?: SubjectRuleSet<ToolSubjectConfig>;
	mcp?: {
		default?: PermissionEffect;
		servers?: Record<string, { default?: PermissionEffect; tools?: Record<string, PermissionEffect> }>;
	};
	skills?: SubjectRuleSet<PermissionEffect>;
	agents?: SubjectRuleSet<PermissionEffect>;
	audit?: { enabled: boolean };
}

export interface EffectRules<T> {
	deny?: T[];
	ask?: T[];
	allow?: T[];
}

export interface FileRule {
	id?: string;
	paths: string[];
	access: FileAccess[];
}

export type ToolSubjectConfig =
	| PermissionEffect
	| {
			default?: PermissionEffect;
			commands?: EffectRules<string>;
	  };

export interface SubjectRuleSet<T> {
	default?: PermissionEffect;
	items?: Record<string, T>;
}

export const permissionProfiles: readonly PermissionProfile[] = ["cautious", "standard", "read-only", "unrestricted"] as const;
export const permissionEffects: readonly PermissionEffect[] = ["allow", "ask", "deny"] as const;
export const fileAccesses: readonly FileAccess[] = ["read", "write"] as const;
export const fileRootAccesses: readonly FileRootAccess[] = ["read-only", "read-write"] as const;
export const writeOperations: readonly PermissionOperation[] = [
	"file.create",
	"file.update",
	"file.replace",
	"file.delete",
	"file.move",
] as const;

export function isWriteOperation(operation: PermissionOperation): boolean {
	return (writeOperations as readonly string[]).includes(operation);
}

export function effectRank(effect: PermissionEffect): number {
	if (effect === "deny") return 3;
	if (effect === "ask") return 2;
	return 1;
}
