import { randomUUID } from "node:crypto";
import path from "node:path";

import { ApprovalCoordinator } from "./approval-coordinator.js";
import { AuditLogger } from "./audit-logger.js";
import { defaultAgentDir, defaultProjectPolicyPath, PolicyLoader } from "./policy-loader.js";
import { PolicyResolver } from "./policy-resolver.js";
import { accessTouchesProtectedResource } from "./protected-resources.js";
import { accessFingerprintShape, stableFingerprint } from "./request-fingerprint.js";
import { ResourceResolver } from "./resource-resolver.js";
import { SessionGrantStore } from "./session-grants.js";
import type {
	PermissionAccess,
	PermissionAction,
	PermissionAuditEntry,
	PermissionErrorCode,
	PermissionMode,
	PermissionPromptContext,
	PermissionRequest,
	PermissionServiceStatus,
	PolicyEvaluation,
	UserPermissionDecision,
} from "./permission-types.js";
import { isWriteAction } from "./permission-types.js";
import { identityEquals } from "./path-utils.js";

export interface PermissionServiceOptions {
	workspaceRoot: string;
	agentDir?: string;
	globalPolicyPath?: string;
	projectPolicyPath?: string;
	projectTrusted?: boolean;
	mode?: PermissionMode;
	promptTimeoutMs?: number;
	auditLogPath?: string;
	auditEnabled?: boolean;
	extraSensitivePaths?: string[];
	extraProtectedPaths?: string[];
	approvalCoordinator?: ApprovalCoordinator;
	sessionGrants?: SessionGrantStore;
}

export interface AuthorizeInput {
	toolCallId: string;
	toolName: string;
	accesses: PermissionAccess[];
	normalizedToolInput: unknown;
	risk?: PermissionRequest["risk"];
	promptContext: PermissionPromptContext;
}

/** 非路径工具的运行时授权输入；路径工具仍应传入真实 PermissionAccess。 */
export interface AuthorizeToolCallInput {
	toolCallId: string;
	toolName: string;
	normalizedToolInput: unknown;
	promptContext: PermissionPromptContext;
}

export type PermissionAuthorizeResult =
	| { ok: true; request: PermissionRequest; evaluation: PolicyEvaluation }
	| { ok: false; code: PermissionErrorCode; message: string; request?: PermissionRequest; resources: Array<{ action: PermissionAction; path: string }> };

/** 工具层统一入口：路径解析后在这里完成策略、grant、UI、审计和重试去重。 */
export class PermissionService {
	private readonly grants: SessionGrantStore;
	private readonly coordinator: ApprovalCoordinator;
	private readonly audit: AuditLogger;
	private readonly loader: PolicyLoader;
	private readonly recentErrors: string[] = [];
	private readonly deniedFingerprints = new Set<string>();
	private mode: PermissionMode;
	private modeOverridden: boolean;
	private lastStatus: PermissionServiceStatus | undefined;

	constructor(private readonly options: PermissionServiceOptions) {
		const agentDir = options.agentDir ?? defaultAgentDir();
		this.mode = options.mode ?? "safe";
		this.modeOverridden = options.mode !== undefined;
		this.grants = options.sessionGrants ?? new SessionGrantStore();
		this.coordinator = options.approvalCoordinator ?? new ApprovalCoordinator();
		this.audit = new AuditLogger({
			enabled: options.auditEnabled ?? false,
			...(options.auditLogPath !== undefined ? { path: options.auditLogPath } : {}),
		});
		this.loader = new PolicyLoader({
			...(options.globalPolicyPath !== undefined ? { globalPolicyPath: options.globalPolicyPath } : {}),
			projectPolicyPath: options.projectPolicyPath ?? defaultProjectPolicyPath(options.workspaceRoot),
			projectTrusted: options.projectTrusted ?? false,
		});
		this.options = { ...options, agentDir };
	}

	get resourceResolver(): ResourceResolver {
		return new ResourceResolver({
			workspaceRoot: this.options.workspaceRoot,
			...(this.options.agentDir !== undefined ? { agentDir: this.options.agentDir } : {}),
			...(this.options.extraSensitivePaths !== undefined ? { extraSensitivePaths: this.options.extraSensitivePaths } : {}),
		});
	}

	getMode(): PermissionMode {
		return this.mode;
	}

	setMode(mode: PermissionMode): void {
		this.mode = mode;
		this.modeOverridden = true;
	}

	getGrants(): SessionGrantStore {
		return this.grants;
	}

	async status(): Promise<PermissionServiceStatus> {
		const loaded = await this.loader.load();
		this.applyConfiguredMode(loaded.global);
		const status: PermissionServiceStatus = {
			mode: this.mode,
			globalPolicy: loaded.global,
			projectPolicy: loaded.project,
			projectTrusted: this.options.projectTrusted ?? false,
			policyGeneration: loaded.generation,
			sessionGrantCount: this.grants.count(),
			recentErrors: [...this.recentErrors],
			auditEnabled: this.audit.isEnabled(),
		};
		this.lastStatus = status;
		return status;
	}

	async explain(access: PermissionAccess, toolName: string): Promise<PolicyEvaluation> {
		const loaded = await this.loader.load();
		this.applyConfiguredMode(loaded.global);
		return new PolicyResolver({
			workspaceRoot: this.options.workspaceRoot,
			global: loaded.global,
			project: loaded.project,
			mode: this.mode,
			explain: true,
		}).evaluate(access, toolName);
	}

	async explainTool(toolName: string): Promise<PolicyEvaluation> {
		const loaded = await this.loader.load();
		this.applyConfiguredMode(loaded.global);
		return new PolicyResolver({
			workspaceRoot: this.options.workspaceRoot,
			global: loaded.global,
			project: loaded.project,
			mode: this.mode,
			explain: true,
		}).evaluateTool(toolName);
	}

	async authorizeToolCall(input: AuthorizeToolCallInput): Promise<PermissionAuthorizeResult> {
		const loaded = await this.loader.load();
		this.applyConfiguredMode(loaded.global);
		const fingerprint = stableFingerprint({
			toolName: input.toolName,
			normalizedToolInput: input.normalizedToolInput,
			accesses: [],
			policyGeneration: loaded.generation,
		});
		const request: PermissionRequest = {
			requestId: `perm_${randomUUID()}`,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			accesses: [],
			risk: "low",
			normalizedInputFingerprint: fingerprint,
			policyGeneration: loaded.generation,
			normalizedToolInput: input.normalizedToolInput,
		};

		if (this.deniedFingerprints.has(fingerprint)) {
			await this.auditDecision(request, "ask", "denied", "user", "PERMISSION_DENIED_BY_USER");
			return this.denied("PERMISSION_DENIED_BY_USER", "The user denied this operation. Do not retry the identical request.", [], request);
		}

		const evaluation = new PolicyResolver({
			workspaceRoot: this.options.workspaceRoot,
			global: loaded.global,
			project: loaded.project,
			mode: this.mode,
		}).evaluateTool(input.toolName);

		if (evaluation.effect === "deny") {
			await this.auditDecision(request, evaluation.effect, "denied", auditSource(evaluation), "PERMISSION_DENIED");
			return this.denied("PERMISSION_DENIED", evaluation.reason, [], request);
		}
		if (evaluation.effect === "allow") {
			await this.auditDecision(request, evaluation.effect, "allowed", auditSource(evaluation));
			return { ok: true, request, evaluation };
		}
		if (!input.promptContext.hasUI) {
			await this.auditDecision(request, evaluation.effect, "denied", "no-ui", "PERMISSION_PROMPT_UNAVAILABLE");
			return this.denied("PERMISSION_PROMPT_UNAVAILABLE", "Permission prompt is unavailable; ask defaults to deny.", [], request);
		}

		const decision = await this.coordinator.request(request, evaluation, input.promptContext);
		if (decision.decision === "deny") {
			this.deniedFingerprints.add(fingerprint);
			await this.auditDecision(request, evaluation.effect, "denied", "user", "PERMISSION_DENIED_BY_USER");
			return this.denied("PERMISSION_DENIED_BY_USER", "The user denied this operation.", [], request);
		}
		await this.auditDecision(request, evaluation.effect, "allowed", "user");
		return { ok: true, request, evaluation: { ...evaluation, effect: "allow", reason: `User decision: ${decision.decision}.` } };
	}

	async authorize(input: AuthorizeInput): Promise<PermissionAuthorizeResult> {
		if (input.accesses.some((access) => isWriteAction(access.action) && accessTouchesProtectedResource(access, this.options))) {
			return this.denied("PERMISSION_PROTECTED_RESOURCE", "Protected permission or Pi metadata cannot be modified by edit.", input.accesses);
		}

		const loaded = await this.loader.load();
		this.applyConfiguredMode(loaded.global);
		const fingerprint = stableFingerprint({
			toolName: input.toolName,
			normalizedToolInput: input.normalizedToolInput,
			accesses: accessFingerprintShape(input.accesses),
			policyGeneration: loaded.generation,
		});
		const request: PermissionRequest = {
			requestId: `perm_${randomUUID()}`,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			accesses: input.accesses,
			risk: input.risk ?? riskForAccesses(input.accesses),
			normalizedInputFingerprint: fingerprint,
			policyGeneration: loaded.generation,
			normalizedToolInput: input.normalizedToolInput,
		};

		if (this.deniedFingerprints.has(fingerprint)) {
			await this.auditDecision(request, "ask", "denied", "user", "PERMISSION_DENIED_BY_USER");
			return this.denied("PERMISSION_DENIED_BY_USER", "The user denied this operation. Do not retry the identical request.", input.accesses, request);
		}

		const resolver = new PolicyResolver({
			workspaceRoot: this.options.workspaceRoot,
			global: loaded.global,
			project: loaded.project,
			mode: this.mode,
		});
		const evaluations = input.accesses.map((access) => resolver.evaluate(access, input.toolName));
		const aggregate = aggregateEvaluations(evaluations);

		if (aggregate.effect === "deny") {
			await this.auditDecision(request, aggregate.effect, "denied", auditSource(aggregate), "PERMISSION_DENIED");
			return this.denied("PERMISSION_DENIED", aggregate.reason, input.accesses, request);
		}

		const sessionGrant = this.grants.find(input.accesses, input.toolCallId, fingerprint);
		if (sessionGrant !== undefined && aggregate.effect === "ask") {
			await this.auditDecision(request, aggregate.effect, "allowed", "session-grant");
			return { ok: true, request, evaluation: { ...aggregate, effect: "allow", reason: `Matched session grant ${sessionGrant.id}.` } };
		}

		if (aggregate.effect === "allow") {
			await this.auditDecision(request, aggregate.effect, "allowed", auditSource(aggregate));
			return { ok: true, request, evaluation: aggregate };
		}

		if (!input.promptContext.hasUI) {
			await this.auditDecision(request, aggregate.effect, "denied", "no-ui", "PERMISSION_PROMPT_UNAVAILABLE");
			return this.denied("PERMISSION_PROMPT_UNAVAILABLE", "Permission prompt is unavailable; ask defaults to deny.", input.accesses, request);
		}

		const decision = await this.coordinator.request(request, aggregate, input.promptContext);
		if (decision.decision === "deny") {
			this.deniedFingerprints.add(fingerprint);
			await this.auditDecision(request, aggregate.effect, "denied", "user", "PERMISSION_DENIED_BY_USER");
			return this.denied("PERMISSION_DENIED_BY_USER", "The user denied this operation.", input.accesses, request);
		}
		this.applyUserDecision(decision, request);
		await this.auditDecision(request, aggregate.effect, "allowed", "user");
		return { ok: true, request, evaluation: { ...aggregate, effect: "allow", reason: `User decision: ${decision.decision}.` } };
	}

	async verifyAccessesUnchanged(accesses: PermissionAccess[]): Promise<boolean> {
		const resolver = this.resourceResolver;
		for (const access of accesses) {
			const current = await resolver.resolve(access.inputPath);
			if (current.canonicalPath !== access.canonicalPath) return false;
			if (current.exists !== access.exists) return false;
			if (current.type !== access.targetType) return false;
			if (access.exists) {
				if (!identityEquals(access.identity, current.identity)) return false;
			} else if (!identityEquals(access.canonicalParentIdentity, current.canonicalParentIdentity)) {
				return false;
			}
		}
		return true;
	}

	consumeOnce(request: PermissionRequest): void {
		this.grants.consumeOnce(request.toolCallId, request.normalizedInputFingerprint);
	}

	cancelAll(reason: string): void {
		this.coordinator.cancelAll(reason);
	}

	private applyConfiguredMode(globalPolicy: PermissionServiceStatus["globalPolicy"]): void {
		if (this.modeOverridden) return;
		const configured = globalPolicy.status === "loaded" ? globalPolicy.policy?.mode : undefined;
		if (configured !== undefined) this.mode = configured;
	}

	private applyUserDecision(decision: UserPermissionDecision, request: PermissionRequest): void {
		if (decision.decision === "allow-once") {
			for (const access of request.accesses) {
				this.grants.add({
					actions: [access.action],
					canonicalPath: access.canonicalPath,
					scope: "exact",
					lifetime: "once",
					toolCallId: request.toolCallId,
					requestFingerprint: request.normalizedInputFingerprint,
					rootIdentity: access.identity ?? access.canonicalParentIdentity,
				});
			}
			return;
		}
		const lifetime = "session";
		for (const access of request.accesses) {
			const directoryScope = access.targetType === "directory" ? access.canonicalPath : path.dirname(access.canonicalPath);
			const actions = actionGrantSet(access.action);
			this.grants.add({
				actions,
				canonicalPath: decision.decision === "allow-session-subtree" ? directoryScope : access.canonicalPath,
				scope: decision.decision === "allow-session-subtree" ? "subtree" : "exact",
				lifetime,
				toolCallId: request.toolCallId,
				requestFingerprint: request.normalizedInputFingerprint,
				...(decision.decision === "allow-session-exact" ? { rootIdentity: access.identity ?? access.canonicalParentIdentity } : {}),
			});
		}
	}

	private denied(
		code: PermissionErrorCode,
		message: string,
		accesses: PermissionAccess[],
		request?: PermissionRequest,
	): PermissionAuthorizeResult {
		this.noteError(`${code}: ${message}`);
		return {
			ok: false,
			code,
			message,
			...(request !== undefined ? { request } : {}),
			resources: accesses.map((access) => ({ action: access.action, path: access.canonicalPath })),
		};
	}

	private noteError(message: string): void {
		this.recentErrors.push(message);
		while (this.recentErrors.length > 5) this.recentErrors.shift();
	}

	private async auditDecision(
		request: PermissionRequest,
		policyEffect: PermissionAuditEntry["policyEffect"],
		finalDecision: PermissionAuditEntry["finalDecision"],
		decisionSource: PermissionAuditEntry["decisionSource"],
		errorCode?: PermissionErrorCode,
	): Promise<void> {
		const entry: PermissionAuditEntry = {
			timestamp: new Date().toISOString(),
			requestId: request.requestId,
			toolCallId: request.toolCallId,
			toolName: request.toolName,
			fingerprint: request.normalizedInputFingerprint,
			policyGeneration: request.policyGeneration,
			accesses: request.accesses.map((access) => ({
				action: access.action,
				canonicalPath: access.canonicalPath,
				boundary: access.boundary,
			})),
			policyEffect,
			finalDecision,
			decisionSource,
			...(errorCode !== undefined ? { errorCode } : {}),
		};
		await this.audit.record(entry);
		const auditError = this.audit.getLastError();
		if (auditError !== undefined) this.noteError(`audit: ${auditError}`);
	}
}

function aggregateEvaluations(evaluations: PolicyEvaluation[]): PolicyEvaluation {
	const deny = evaluations.find((item) => item.effect === "deny");
	if (deny !== undefined) return deny;
	const ask = evaluations.find((item) => item.effect === "ask");
	if (ask !== undefined) return ask;
	return evaluations[0] ?? { effect: "ask", reason: "Empty permission request.", denyFloor: false };
}

function auditSource(evaluation: PolicyEvaluation): PermissionAuditEntry["decisionSource"] {
	if (evaluation.matchedRule?.source === "global") return "global-rule";
	if (evaluation.matchedRule?.source === "project") return "project-rule";
	if (evaluation.matchedRule?.source === "builtin") return "builtin";
	if (evaluation.reason.includes("yolo") || evaluation.reason.includes("read-only")) return "mode";
	return "builtin";
}

function riskForAccesses(accesses: PermissionAccess[]): PermissionRequest["risk"] {
	if (accesses.some((access) => access.boundary === "sensitive")) return "critical";
	if (accesses.some((access) => isWriteAction(access.action) && access.boundary !== "workspace")) return "high";
	if (accesses.some((access) => access.boundary !== "workspace")) return "medium";
	return "low";
}

function actionGrantSet(action: PermissionAction): PermissionAction[] {
	if (action === "fs.list") return ["fs.list", "fs.read"];
	return [action];
}
