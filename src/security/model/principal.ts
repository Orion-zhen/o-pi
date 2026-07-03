import os from "node:os";

import { digest } from "./digest.js";
import type { AgentScope, DelegationCapability, PrincipalContext } from "./types.js";

export function defaultDelegation(agentInstanceId: string, scope: AgentScope): DelegationCapability {
	return {
		issuerAgentInstanceId: agentInstanceId,
		subjectAgentInstanceId: agentInstanceId,
		actionPatterns: ["*"],
		resourcePatterns: ["*"],
		scopeRoot: scope.root,
		expiresAt: Number.MAX_SAFE_INTEGER,
		maxDepth: 0,
		parentCapabilityDigest: "root",
		nonce: "root",
		signature: "root",
	};
}

export function defaultPrincipal(input: {
	sessionId: string;
	workspaceRoot: string;
	agentDefinitionId?: string;
	agentInstanceId?: string;
}): PrincipalContext {
	const agentDefinitionId = input.agentDefinitionId ?? "main";
	const agentInstanceId = input.agentInstanceId ?? `${agentDefinitionId}:${input.sessionId}`;
	const scope = { root: input.workspaceRoot, patterns: [`${input.workspaceRoot}/**`] };
	return {
		userId: os.userInfo().username,
		sessionId: input.sessionId,
		agentDefinitionId,
		agentInstanceId,
		lineage: [agentInstanceId],
		scope,
		delegation: defaultDelegation(agentInstanceId, scope),
	};
}

export function principalDigest(principal: PrincipalContext): string {
	return digest({
		userId: principal.userId,
		sessionId: principal.sessionId,
		agentDefinitionId: principal.agentDefinitionId,
		agentInstanceId: principal.agentInstanceId,
		parentAgentInstanceId: principal.parentAgentInstanceId,
		lineage: principal.lineage,
		scope: principal.scope,
		delegation: principal.delegation,
	});
}
