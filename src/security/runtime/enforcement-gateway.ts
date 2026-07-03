import { randomUUID } from "node:crypto";

import { ConsentService, type ApprovalPromptContext } from "../approval/approval.js";
import { GrantStore } from "../approval/grants.js";
import { ComponentRegistry } from "../analysis/component-registry.js";
import { AuditLogger } from "../audit/audit.js";
import { cloneJson, deepFreeze, digest } from "../model/digest.js";
import { principalDigest } from "../model/principal.js";
import { toolResourceUri } from "../model/resources.js";
import type {
	AnalysisResult,
	AuthorizationAtom,
	AuthorizationDecision,
	AuthorizationRequest,
	ExecutionTicket,
	ImmutableExecutionCall,
} from "../model/types.js";
import { PolicyStore } from "../policy/config.js";
import { evaluateAuthorization } from "../policy/policy.js";

export class EnforcementError extends Error {
	constructor(
		readonly code:
			| "SECURITY_DENIED"
			| "SECURITY_COMPONENT_UNKNOWN"
			| "SECURITY_ANALYSIS_FAILED"
			| "SECURITY_TICKET_INVALID"
			| "SECURITY_TICKET_CONSUMED",
		message: string,
	) {
		super(message);
	}
}

/** 唯一执行网关：prepare 固定授权上下文，consume 绑定实际执行参数并单次消费。 */
export class EnforcementGateway {
	private readonly consent = new ConsentService();

	constructor(
		private readonly dependencies: {
			registry: ComponentRegistry;
			policies: PolicyStore;
			grants: GrantStore;
			audit: AuditLogger;
		},
	) {}

	async prepare(call: ImmutableExecutionCall, promptContext: ApprovalPromptContext): Promise<ExecutionTicket> {
		const frozenInput = deepFreeze(cloneJson(call.input));
		const snapshot = await this.dependencies.policies.snapshot();
		const registration = this.dependencies.registry.get(call.component.id);
		if (registration === undefined) throw new EnforcementError("SECURITY_COMPONENT_UNKNOWN", "Component is not registered.");
		const analysis = await this.analyze(registration.analyzer.analyze(frozenInput, {
			workspaceRoot: call.context.workspaceRoot,
			agentDir: call.context.agentDir,
			component: call.component,
			...(call.context.signal !== undefined ? { signal: call.context.signal } : {}),
		}));
		const atoms = withInvocationAtom(analysis.atoms, call);
		const request: AuthorizationRequest = {
			requestId: `auth_${randomUUID()}`,
			executionId: call.executionId,
			principal: call.principal,
			component: call.component,
			exactness: analysis.exactness,
			inputDigest: digest(frozenInput),
			atoms,
			context: {
				workspaceId: digest(call.context.workspaceRoot),
				scopeUri: `file://${call.principal.scope.root.replace(/\\/g, "/")}`,
				interactive: call.context.interactive,
				policyDigest: snapshot.digest,
				registryDigest: this.dependencies.registry.registryDigest(),
				timestamp: Date.now(),
			},
		};
		let decision = evaluateAuthorization(request, snapshot.compiled);
		await this.dependencies.grants.load();
		const alwaysAsk = decision.riskLabels.includes("approval:always-ask");
		if (decision.kind === "ask" && !alwaysAsk && this.dependencies.grants.find(request).length > 0) {
			decision = { kind: "allow", reason: "Grant matched.", matchedPolicyIds: ["grant"], riskLabels: [] };
		}
		if (decision.kind === "ask") decision = await this.resolveConsent(request, decision, promptContext);
		await this.dependencies.audit.record(request, decision, frozenInput);
		if (decision.kind !== "allow") throw new EnforcementError("SECURITY_DENIED", decision.reason);
		return ticketFromRequest(request);
	}

	async consume(ticket: ExecutionTicket, call: ImmutableExecutionCall): Promise<void> {
		if (ticket.consumed) throw new EnforcementError("SECURITY_TICKET_CONSUMED", "Execution ticket has already been consumed.");
		if (ticket.expiry < Date.now()) throw new EnforcementError("SECURITY_TICKET_INVALID", "Execution ticket expired.");
		if (ticket.request.executionId !== call.executionId) throw new EnforcementError("SECURITY_TICKET_INVALID", "Execution id changed.");
		if (ticket.principalDigest !== principalDigest(call.principal)) throw new EnforcementError("SECURITY_TICKET_INVALID", "Principal changed.");
		if (ticket.componentDigest !== digest(call.component)) throw new EnforcementError("SECURITY_TICKET_INVALID", "Component identity changed.");
		if (ticket.policyDigest !== (await this.dependencies.policies.snapshot()).digest) throw new EnforcementError("SECURITY_TICKET_INVALID", "Policy changed.");
		if (ticket.registryDigest !== this.dependencies.registry.registryDigest()) throw new EnforcementError("SECURITY_TICKET_INVALID", "Registry changed.");
		if (ticket.delegationDigest !== digest(call.principal.delegation)) throw new EnforcementError("SECURITY_TICKET_INVALID", "Delegation changed.");
		const frozenInput = deepFreeze(cloneJson(call.input));
		if (ticket.inputDigest !== digest(frozenInput)) throw new EnforcementError("SECURITY_TICKET_INVALID", "Input changed.");
		const registration = this.dependencies.registry.get(call.component.id);
		if (registration === undefined) throw new EnforcementError("SECURITY_COMPONENT_UNKNOWN", "Component is not registered.");
		const analysis = await this.analyze(registration.analyzer.analyze(frozenInput, {
			workspaceRoot: call.context.workspaceRoot,
			agentDir: call.context.agentDir,
			component: call.component,
			...(call.context.signal !== undefined ? { signal: call.context.signal } : {}),
		}));
		const atoms = withInvocationAtom(analysis.atoms, call);
		if (ticket.atomDigest !== digest(atoms)) throw new EnforcementError("SECURITY_TICKET_INVALID", "Authorization atoms changed.");
		ticket.consumed = true;
	}

	private async analyze(result: Promise<AnalysisResult>): Promise<AnalysisResult> {
		try {
			return await result;
		} catch (error) {
			throw new EnforcementError("SECURITY_ANALYSIS_FAILED", error instanceof Error ? error.message : String(error));
		}
	}

	private async resolveConsent(
		request: AuthorizationRequest,
		decision: AuthorizationDecision,
		context: ApprovalPromptContext,
	): Promise<AuthorizationDecision> {
		const approval = await this.consent.request(request, decision, context);
		if (!approval.ok) return { kind: "deny", reason: `Approval ${approval.reason}.`, matchedPolicyIds: ["approval"], riskLabels: decision.riskLabels };
		if (approval.choice === "deny") return { kind: "deny", reason: "User denied.", matchedPolicyIds: ["approval"], riskLabels: decision.riskLabels };
		if (decision.riskLabels.includes("approval:always-ask") && approval.choice !== "allow-once") {
			return { kind: "deny", reason: "always-ask only allows one-time approval.", matchedPolicyIds: ["approval"], riskLabels: decision.riskLabels };
		}
		if (approval.choice === "allow-session-exact") this.dependencies.grants.addSession(request, "exact");
		if (approval.choice === "allow-session-subtree") this.dependencies.grants.addSession(request, "subtree");
		if (approval.choice === "create-persistent-rule") await this.dependencies.grants.addPersistent(request);
		return { kind: "allow", reason: `User approved: ${approval.choice}.`, matchedPolicyIds: ["approval"], riskLabels: decision.riskLabels };
	}
}

function ticketFromRequest(request: AuthorizationRequest): ExecutionTicket {
	return {
		id: `ticket_${randomUUID()}`,
		request,
		principalDigest: principalDigest(request.principal),
		componentDigest: digest(request.component),
		inputDigest: request.inputDigest,
		atomDigest: digest(request.atoms),
		policyDigest: request.context.policyDigest,
		registryDigest: request.context.registryDigest,
		delegationDigest: digest(request.principal.delegation),
		expiry: Date.now() + 120000,
		nonce: randomUUID(),
		consumed: false,
	};
}

function withInvocationAtom(atoms: readonly AuthorizationAtom[], call: ImmutableExecutionCall): readonly AuthorizationAtom[] {
	const action = call.component.kind === "tool" ? "tool.invoke" : call.component.kind === "bash" ? "exec.shell.opaque" : undefined;
	const invocation = action === undefined ? [] : [{ action, resource: action === "tool.invoke" ? toolResourceUri(call.component) : "exec://shell/bash" } satisfies AuthorizationAtom];
	return [...invocation, ...atoms];
}
