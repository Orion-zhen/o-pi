import path from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

import { componentIdentity, ComponentRegistry } from "../analysis/component-registry.js";
import { bashAnalyzer, fileToolAnalyzer, opaqueToolAnalyzer } from "../analysis/analyzers.js";
import { defaultPromptContext, type ApprovalPromptContext } from "../approval/approval.js";
import { GrantStore } from "../approval/grants.js";
import { AuditLogger } from "../audit/audit.js";
import { buildPermissionCatalog, type PermissionCatalog } from "../catalog/permission-catalog.js";
import { digest } from "../model/digest.js";
import { defaultPrincipal } from "../model/principal.js";
import type { ComponentIdentity, ExecutionTicket, PrincipalContext } from "../model/types.js";
import { PolicyStore } from "../policy/config.js";
import { componentEnabled } from "../policy/policy.js";
import { EnforcementError, EnforcementGateway } from "./enforcement-gateway.js";
import { explainUserPolicy, type ExplainQuery } from "../explain/user-policy-explainer.js";

export interface SecurityServiceOptions {
	workspaceRoot: string;
	agentDir: string;
	projectTrusted: boolean;
	globalPolicyPath?: string;
	projectPolicyPath?: string;
	auditLogPath?: string;
	grantPath?: string;
	sessionId?: string;
}

export interface SecurityStatus {
	policyDigest: string;
	registryDigest: string;
	projectTrusted: boolean;
	catalog: PermissionCatalog;
	components: ReturnType<ComponentRegistry["catalog"]>;
}

export class SecurityService {
	private readonly registry = new ComponentRegistry();
	private readonly policies: PolicyStore;
	private readonly grants: GrantStore;
	private readonly audit: AuditLogger;
	private readonly gateway: EnforcementGateway;
	private readonly ticketsByExecution = new Map<string, ExecutionTicket>();

	constructor(private readonly options: SecurityServiceOptions) {
		this.registerBuiltinComponents();
		this.policies = new PolicyStore({ ...options, catalog: () => this.permissionCatalog() });
		this.grants = new GrantStore(options.grantPath ?? path.join(options.agentDir, "security-state", "grants.json"));
		this.audit = new AuditLogger(options.auditLogPath ?? path.join(options.agentDir, "security-state", "audit.jsonl"));
		this.gateway = new EnforcementGateway({ registry: this.registry, policies: this.policies, grants: this.grants, audit: this.audit });
	}

	async status(): Promise<SecurityStatus> {
		const snapshot = await this.policies.snapshot();
		return {
			policyDigest: snapshot.digest,
			registryDigest: this.registry.registryDigest(),
			projectTrusted: this.options.projectTrusted,
			catalog: this.permissionCatalog(),
			components: await this.exposedCatalog(this.principal()),
		};
	}

	async syncRegisteredTools(tools: ToolInfo[]): Promise<void> {
		for (const tool of tools) {
			if (tool.name === "ls" || tool.name === "read" || tool.name === "edit") continue;
			this.registry.register({
				identity: componentIdentity({
					kind: tool.name === "bash" ? "bash" : "tool",
					displayName: tool.name,
					sourceDigest: digest(toolSourceEvidence(tool)),
					schemaDigest: digest(toolSchemaEvidence(tool)),
				}),
				analyzer: tool.name === "bash" ? bashAnalyzer() : opaqueToolAnalyzer(),
			});
		}
	}

	async exposedCatalog(principal = this.principal()): Promise<ReturnType<ComponentRegistry["catalog"]>> {
		const snapshot = await this.policies.snapshot();
		return this.registry
			.catalog()
			.filter(
				(entry) =>
					entry.active &&
					!entry.conflict &&
					componentEnabled(entry.identity, principal.agentDefinitionId, snapshot.compiled.componentEnablement),
			);
	}

	permissionCatalog(): PermissionCatalog {
		return buildPermissionCatalog(this.registry);
	}

	async explain(query: ExplainQuery): Promise<string> {
		const snapshot = await this.policies.snapshot();
		return explainUserPolicy(snapshot.compiled, query, this.options.workspaceRoot);
	}

	async setUserMode(input: Parameters<PolicyStore["setUserMode"]>[0]): Promise<void> {
		await this.policies.setUserMode(input);
	}

	async writePermissionSchema(): Promise<void> {
		await this.policies.writeSchema(path.join(this.options.agentDir, "permissions.schema.json"));
	}

	async prepareToolCall(input: {
		toolCallId: string;
		toolName: string;
		normalizedToolInput: unknown;
		promptContext: ApprovalPromptContext;
		principal?: PrincipalContext;
	}): Promise<ExecutionTicket> {
		const component = this.resolveComponent(input.toolName);
		const ticket = await this.gateway.prepare(
			{
				executionId: input.toolCallId,
				principal: input.principal ?? this.principal(),
				component,
				input: input.normalizedToolInput,
				context: { workspaceRoot: this.options.workspaceRoot, agentDir: this.options.agentDir, interactive: input.promptContext.hasUI },
			},
			input.promptContext,
		);
		this.ticketsByExecution.set(input.toolCallId, ticket);
		return ticket;
	}

	async authorizeToolExecution(input: {
		toolCallId: string;
		toolName: string;
		params: unknown;
		promptContext?: ApprovalPromptContext;
		principal?: PrincipalContext;
	}): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
		try {
			const component = this.resolveComponent(input.toolName);
			const principal = input.principal ?? this.principal();
			const call = {
				executionId: input.toolCallId,
				principal,
				component,
				input: input.params,
				context: { workspaceRoot: this.options.workspaceRoot, agentDir: this.options.agentDir, interactive: input.promptContext?.hasUI ?? false },
			};
			const prepared = this.ticketsByExecution.get(input.toolCallId);
			const ticket = prepared ?? await this.gateway.prepare(call, input.promptContext ?? defaultPromptContext());
			await this.gateway.consume(ticket, call);
			return { ok: true };
		} catch (error) {
			if (error instanceof EnforcementError) return { ok: false, code: error.code, message: error.message };
			return { ok: false, code: "SECURITY_INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
		}
	}

	cancelAll(): void {
		this.ticketsByExecution.clear();
		this.grants.clearSession();
	}

	principal(agentDefinitionId = "main"): PrincipalContext {
		return defaultPrincipal({
			sessionId: this.options.sessionId ?? "ephemeral",
			workspaceRoot: this.options.workspaceRoot,
			agentDefinitionId,
		});
	}

	getGateway(): EnforcementGateway {
		return this.gateway;
	}

	getRegistry(): ComponentRegistry {
		return this.registry;
	}

	private resolveComponent(toolName: string): ComponentIdentity {
		const registration = this.registry.resolve(toolName === "bash" ? "bash" : "tool", toolName);
		if (registration === undefined) {
			throw new EnforcementError("SECURITY_COMPONENT_UNKNOWN", `Component is not active or has an unresolved identity conflict: ${toolName}.`);
		}
		return registration.identity;
	}

	private registerBuiltinComponents(): void {
		for (const name of ["ls", "read", "edit"] as const) {
			this.registry.register({
				identity: componentIdentity({ kind: "tool", displayName: name, sourceDigest: digest({ builtin: "o-pi", name }) }),
				analyzer: fileToolAnalyzer(name),
			});
		}
		this.registry.register({
			identity: componentIdentity({ kind: "bash", displayName: "bash", sourceDigest: digest({ builtin: "pi", name: "bash" }) }),
			analyzer: bashAnalyzer(),
		});
	}
}

function toolSourceEvidence(tool: ToolInfo): unknown {
	return { name: tool.name, sourceInfo: tool.sourceInfo };
}

function toolSchemaEvidence(tool: ToolInfo): unknown {
	return { name: tool.name, description: tool.description };
}
