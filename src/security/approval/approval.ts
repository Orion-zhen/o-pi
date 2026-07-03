import type { AuthorizationDecision, AuthorizationRequest } from "../model/types.js";
import { digest } from "../model/digest.js";

export type UserApprovalChoice = "allow-once" | "allow-session-exact" | "allow-session-subtree" | "create-persistent-rule" | "deny";

export interface ApprovalPromptContext {
	hasUI: boolean;
	timeoutMs: number;
	signal?: AbortSignal;
	prompt(request: AuthorizationRequest, decision: AuthorizationDecision): Promise<UserApprovalChoice>;
}

export type ApprovalResult = { ok: true; choice: UserApprovalChoice } | { ok: false; reason: "timeout" | "cancelled" | "ui-error" };

/** 审批合并 key 绑定完整 canonical request digest，避免跨 Agent 或跨输入复用。 */
export class ConsentService {
	private readonly pending = new Map<string, Promise<ApprovalResult>>();

	async request(request: AuthorizationRequest, decision: AuthorizationDecision, context: ApprovalPromptContext): Promise<ApprovalResult> {
		if (!context.hasUI) return { ok: false, reason: "ui-error" };
		if (context.signal?.aborted) return { ok: false, reason: "cancelled" };
		const key = canonicalApprovalKey(request);
		const existing = this.pending.get(key);
		if (existing !== undefined) return await existing;
		const created = this.askWithTimeout(request, decision, context).finally(() => {
			this.pending.delete(key);
		});
		this.pending.set(key, created);
		return await created;
	}

	private async askWithTimeout(request: AuthorizationRequest, decision: AuthorizationDecision, context: ApprovalPromptContext): Promise<ApprovalResult> {
		let timeout: NodeJS.Timeout | undefined;
		try {
			const timeoutPromise = new Promise<ApprovalResult>((resolve) => {
				timeout = setTimeout(() => resolve({ ok: false, reason: "timeout" }), context.timeoutMs);
			});
			const promptPromise = context.prompt(request, decision).then((choice): ApprovalResult => ({ ok: true, choice }));
			return await Promise.race([timeoutPromise, promptPromise]);
		} catch {
			return { ok: false, reason: "ui-error" };
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
		}
	}
}

export function canonicalApprovalKey(request: AuthorizationRequest): string {
	return digest({
		principal: request.principal,
		lineage: request.principal.lineage,
		component: request.component,
		inputDigest: request.inputDigest,
		atoms: request.atoms,
		policyDigest: request.context.policyDigest,
		registryDigest: request.context.registryDigest,
		delegationDigest: digest(request.principal.delegation),
	});
}

export function defaultPromptContext(): ApprovalPromptContext {
	return { hasUI: false, timeoutMs: 120000, prompt: async () => "deny" };
}

