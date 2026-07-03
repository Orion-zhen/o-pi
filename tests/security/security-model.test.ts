import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { componentIdentity, ComponentRegistry } from "../../src/security/analysis/component-registry.js";
import { opaqueToolAnalyzer } from "../../src/security/analysis/analyzers.js";
import { AuditLogger, redact } from "../../src/security/audit/audit.js";
import { digest } from "../../src/security/model/digest.js";
import { defaultPrincipal } from "../../src/security/model/principal.js";
import type { AuthorizationRequest, ComponentIdentity, ImmutableExecutionCall } from "../../src/security/model/types.js";
import { evaluateAuthorization, type CompiledSecurityPolicy } from "../../src/security/policy/policy.js";
import type { UserPermissionConfig } from "../../src/security/config/user-config.js";
import { strictestMode } from "../../src/security/config/user-config.js";
import { validateUserPermissionSemantics, validateUserPermissionShape } from "../../src/security/config/user-schema.js";
import { buildPermissionCatalog } from "../../src/security/catalog/permission-catalog.js";
import { EnforcementGateway } from "../../src/security/runtime/enforcement-gateway.js";
import { SecurityService } from "../../src/security/runtime/security-service.js";
import { GrantStore } from "../../src/security/approval/grants.js";
import { readWorkspaceFile } from "../../src/file-tools/read-tool.js";
import { editWorkspace } from "../../src/file-tools/edit-tool.js";

let workspace: string;
let agentDir: string;
let outside: string;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "o-pi-sec-ws-"));
	agentDir = await mkdtemp(path.join(os.tmpdir(), "o-pi-sec-agent-"));
	outside = await mkdtemp(path.join(os.tmpdir(), "o-pi-sec-out-"));
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	await rm(agentDir, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
});

describe("EnforcementGateway", () => {
	it("拒绝 hook 后修改参数、无 ticket 执行、重复消费和 policy 变化", async () => {
		await writeFile(path.join(workspace, "a.txt"), "a\n");
		await writeFile(path.join(workspace, "b.txt"), "b\n");
		const service = new SecurityService({ workspaceRoot: workspace, agentDir, projectTrusted: false });
		const okTicket = await service.prepareToolCall({
			toolCallId: "read-1",
			toolName: "read",
			normalizedToolInput: { path: "a.txt" },
			promptContext: noUi(),
		});
		expect(await readWorkspaceFile(workspace, { path: "b.txt" }, { securityService: service, toolCallId: "read-1", promptContext: noUi() })).toMatchObject({
			status: "failed",
			error: { code: "SECURITY_TICKET_INVALID" },
		});
		await service.prepareToolCall({ toolCallId: "read-2", toolName: "read", normalizedToolInput: { path: "a.txt" }, promptContext: noUi() });
		expect(await readWorkspaceFile(workspace, { path: "a.txt" }, { securityService: service, toolCallId: "read-2", promptContext: noUi() })).toMatchObject({
			content: "a\n",
		});
		expect(await readWorkspaceFile(workspace, { path: "a.txt" }, { securityService: service, toolCallId: "read-2", promptContext: noUi() })).toMatchObject({
			status: "failed",
			error: { code: "SECURITY_TICKET_CONSUMED" },
		});
		okTicket.consumed = false;
		okTicket.policyDigest = "changed";
		await expect(service.getGateway().consume(okTicket, callFor(service, "read-1", service.getRegistry().resolve("tool", "read")!.identity, { path: "a.txt" }))).rejects.toMatchObject({
			code: "SECURITY_TICKET_INVALID",
		});
	});

	it("identity、input、atoms、registry、delegation 任一变化都会使 ticket 失效", async () => {
		await writeFile(path.join(workspace, "a.txt"), "a\n");
		const service = new SecurityService({ workspaceRoot: workspace, agentDir, projectTrusted: false });
		const component = service.getRegistry().resolve("tool", "read")!.identity;
		const ticket = await service.prepareToolCall({ toolCallId: "x", toolName: "read", normalizedToolInput: { path: "a.txt" }, promptContext: noUi() });
		const base = callFor(service, "x", component, { path: "a.txt" });
		await expect(service.getGateway().consume({ ...ticket, componentDigest: "changed" }, base)).rejects.toMatchObject({ code: "SECURITY_TICKET_INVALID" });
		await expect(service.getGateway().consume({ ...ticket }, { ...base, input: { path: "missing.txt" } })).rejects.toMatchObject({ code: "SECURITY_TICKET_INVALID" });
		await expect(service.getGateway().consume({ ...ticket, atomDigest: "changed" }, base)).rejects.toMatchObject({ code: "SECURITY_TICKET_INVALID" });
		service.getRegistry().register({ identity: componentIdentity({ kind: "tool", displayName: "other", sourceDigest: digest("x") }), analyzer: opaqueToolAnalyzer() });
		await expect(service.getGateway().consume({ ...ticket }, base)).rejects.toMatchObject({ code: "SECURITY_TICKET_INVALID" });
		const changedDelegation = { ...base, principal: { ...base.principal, delegation: { ...base.principal.delegation, nonce: "changed" } } };
		await expect(service.getGateway().consume({ ...ticket }, changedDelegation)).rejects.toMatchObject({ code: "SECURITY_TICKET_INVALID" });
	});
});

describe("atomic authorization", () => {
	it("任一 atom 被拒绝则整次调用拒绝，未知 analyzer 产生 opaque atom，空 atom 不允许", async () => {
		const component = componentIdentity({ kind: "tool", displayName: "demo", sourceDigest: digest("demo") });
		const policy = internalPolicy({
			enabledTools: ["demo"],
			permits: [{ id: "invoke-only", actions: ["tool.invoke"], resources: ["tool://**"] }],
		});
		const request = requestFor(component, [
			{ action: "tool.invoke", resource: `tool://tool/demo@${component.sourceDigest}` },
			{ action: "fs.read", resource: "file:///blocked.txt" },
		]);
		expect(evaluateAuthorization(request, policy)).toMatchObject({ kind: "deny" });
		expect(evaluateAuthorization({ ...request, atoms: [] }, policy)).toMatchObject({ kind: "deny" });
		const registry = new ComponentRegistry();
		registry.register({ identity: component, analyzer: opaqueToolAnalyzer() });
		const result = await registry.get(component.id)!.analyzer.analyze({}, { workspaceRoot: workspace, agentDir, component });
		expect(result.atoms).toEqual([{ action: "tool.invoke.opaque", resource: `tool://tool/demo@${component.sourceDigest}` }]);
	});
});

describe("用户权限配置", () => {
	it("schema 和 semantic validator 拒绝内部权限字段与未知名称", () => {
		expect(validateUserPermissionShape({ version: 1, permits: [{ actions: ["fs.read"], resources: ["file:///**"] }] })).toContain('Unknown property "permits".');
		const registry = new ComponentRegistry();
		registry.register({ identity: componentIdentity({ kind: "tool", displayName: "read", sourceDigest: digest("read") }), analyzer: opaqueToolAnalyzer() });
		const catalog = buildPermissionCatalog(registry);
		expect(validateUserPermissionSemantics({ version: 1, global: { tools: { raed: "allow" } } }, catalog).join("\n")).toContain('Unknown tool "raed". Did you mean "read"?');
		expect(validateUserPermissionSemantics({ version: 1, global: { tools: { sourceDigest: "allow" } } }, catalog).join("\n")).toContain("internal field");
	});

	it("同名组件冲突不能静默覆盖，模式合并按固定强度取最严格", () => {
		const registry = new ComponentRegistry();
		registry.register({ identity: componentIdentity({ kind: "tool", displayName: "same", sourceDigest: digest("a") }), analyzer: opaqueToolAnalyzer() });
		registry.register({ identity: componentIdentity({ kind: "tool", displayName: "same", sourceDigest: digest("b") }), analyzer: opaqueToolAnalyzer() });
		const catalog = buildPermissionCatalog(registry);
		expect(validateUserPermissionSemantics({ version: 1, global: { tools: { same: "allow" } } }, catalog).join("\n")).toContain("identity conflict");
		expect(strictestMode("allow", "ask")).toBe("ask");
		expect(strictestMode("allow", "always-ask")).toBe("always-ask");
		expect(strictestMode("ask", "always-ask")).toBe("always-ask");
		expect(strictestMode("allow", "off")).toBe("off");
	});
});

describe("Agent 与组件", () => {
	it("同一工具对不同 Agent 权限不同，disabled component 不暴露且不能执行，同名不同来源冲突", async () => {
		await writeFile(path.join(workspace, "a.txt"), "a\n");
		const policyPath = path.join(agentDir, "permissions.jsonc");
		await writeFile(policyPath, JSON.stringify({
			version: 1,
			global: { tools: { read: "allow", bash: "off", "*": "off" }, subagents: { main: "off", "*": "off" } },
			agents: { main: { tools: { read: "allow", "*": "off" } }, reviewer: { tools: { read: "off", "*": "off" } } },
			paths: [{ match: "${workspace}/**", agents: { main: { tools: { read: "allow" } }, reviewer: { tools: { read: "off" } } } }],
		} satisfies UserPermissionConfig));
		const service = new SecurityService({ workspaceRoot: workspace, agentDir, projectTrusted: false, globalPolicyPath: policyPath });
		service.getRegistry().register({ identity: componentIdentity({ kind: "agent", displayName: "reviewer", sourceDigest: digest("reviewer") }), analyzer: opaqueToolAnalyzer() });
		expect(await readWorkspaceFile(workspace, { path: "a.txt" }, { securityService: service, toolCallId: "main" })).toMatchObject({ content: "a\n" });
		expect(await readWorkspaceFile(workspace, { path: "a.txt" }, { securityService: service, toolCallId: "reviewer", principal: service.principal("reviewer") })).toMatchObject({
			status: "failed",
		});
		expect((await service.exposedCatalog()).some((entry) => entry.identity.displayName === "bash")).toBe(false);
		await expect(service.prepareToolCall({ toolCallId: "bash", toolName: "bash", normalizedToolInput: "pwd", promptContext: noUi() })).rejects.toMatchObject({
			code: "SECURITY_DENIED",
		});
		const registry = new ComponentRegistry();
		registry.register({ identity: componentIdentity({ kind: "tool", displayName: "same", sourceDigest: digest("a") }), analyzer: opaqueToolAnalyzer() });
		registry.register({ identity: componentIdentity({ kind: "tool", displayName: "same", sourceDigest: digest("b") }), analyzer: opaqueToolAnalyzer() });
		expect(registry.resolve("tool", "same")).toBeUndefined();
		expect(registry.catalog().every((entry) => entry.conflict)).toBe(true);
	});

	it("子代理 capability 只能衰减，cwd 变化不改变 scope", () => {
		const parent = defaultPrincipal({ sessionId: "s", workspaceRoot: workspace, agentDefinitionId: "main" });
		const child = {
			...defaultPrincipal({ sessionId: "s", workspaceRoot: workspace, agentDefinitionId: "reviewer" }),
			parentAgentInstanceId: parent.agentInstanceId,
			lineage: [...parent.lineage, "reviewer:s"],
			delegation: {
				...parent.delegation,
				issuerAgentInstanceId: parent.agentInstanceId,
				subjectAgentInstanceId: "reviewer:s",
				actionPatterns: ["fs.read"],
				resourcePatterns: [`file://${workspace.replace(/\\/g, "/")}/src/**`],
				maxDepth: 0,
			},
		};
		expect(child.scope.root).toBe(workspace);
		expect(new Set(child.delegation.actionPatterns).has("fs.write")).toBe(false);
		expect(child.delegation.maxDepth).toBeLessThanOrEqual(parent.delegation.maxDepth);
	});
});

describe("files, grants and audit", () => {
	it("symlink 替换后 ticket 失效，父目录 identity 变化后 create 失败，rename 检查所有 atom", async () => {
		await writeFile(path.join(workspace, "inside.txt"), "inside\n");
		await writeFile(path.join(outside, "outside.txt"), "outside\n");
		try {
			await symlink(path.join(workspace, "inside.txt"), path.join(workspace, "link.txt"));
		} catch {
			return;
		}
		const service = new SecurityService({ workspaceRoot: workspace, agentDir, projectTrusted: false });
		await service.prepareToolCall({ toolCallId: "link", toolName: "read", normalizedToolInput: { path: "link.txt" }, promptContext: noUi() });
		await rm(path.join(workspace, "link.txt"), { force: true });
		await symlink(path.join(outside, "outside.txt"), path.join(workspace, "link.txt"));
		expect(await readWorkspaceFile(workspace, { path: "link.txt" }, { securityService: service, toolCallId: "link" })).toMatchObject({
			status: "failed",
			error: { code: "SECURITY_TICKET_INVALID" },
		});

		await mkdir(path.join(workspace, "dir"));
		await service.prepareToolCall({
			toolCallId: "create",
			toolName: "edit",
			normalizedToolInput: { operations: [{ type: "create_file", path: "dir/a.txt", content: "a\n" }] },
			promptContext: noUi(),
		});
		await rm(path.join(workspace, "dir"), { recursive: true, force: true });
		await mkdir(path.join(workspace, "dir"));
		expect(await editWorkspace(workspace, { operations: [{ type: "create_file", path: "dir/a.txt", content: "a\n" }] }, { permission: { securityService: service, toolCallId: "create" } })).toMatchObject({
			status: "failed",
			error: { code: "SECURITY_TICKET_INVALID" },
		});

		await writeFile(path.join(workspace, "move.txt"), "move\n");
		await service.prepareToolCall({
			toolCallId: "move",
			toolName: "edit",
			normalizedToolInput: { operations: [{ type: "move_file", from: "move.txt", to: "moved.txt", base_version: digest(Buffer.from("move\n")) }] },
			promptContext: noUi(),
		});
		const ticket = await service.prepareToolCall({
			toolCallId: "move2",
			toolName: "edit",
			normalizedToolInput: { operations: [{ type: "move_file", from: "move.txt", to: "moved.txt", base_version: "x" }] },
			promptContext: noUi(),
		});
		expect(ticket.request.atoms.map((atom) => atom.action)).toEqual(expect.arrayContaining(["fs.read", "fs.delete", "fs.create", "fs.write", "fs.rename"]));
	});

	it("audit redaction 移除 token、password、Authorization header 和环境变量秘密", async () => {
		const text = redact({ Authorization: "Bearer abc.def", password: "p", api_key: "k", GITHUB_TOKEN: "secret" });
		expect(text).not.toContain("abc.def");
		expect(text).not.toContain("secret");
		expect(text).not.toContain("\"p\"");
		const audit = new AuditLogger(path.join(agentDir, "audit.jsonl"));
		const component = componentIdentity({ kind: "tool", displayName: "demo", sourceDigest: digest("demo") });
		await audit.record(requestFor(component, [{ action: "tool.invoke", resource: "tool://demo" }]), { kind: "deny", reason: "x", matchedPolicyIds: ["x"], riskLabels: [] }, { token: "secret" });
		const [entry] = await audit.tail(1);
		expect(entry?.requestDigest).toBeDefined();
		expect(JSON.stringify(entry)).not.toContain("secret");
	});
});

describe("policy properties", () => {
	it("新增 boundary/forbid 和缩小 scope 不增加权限，approval 不突破 boundary", () => {
		for (let index = 0; index < 20; index += 1) {
			const component = componentIdentity({ kind: "tool", displayName: "read", sourceDigest: digest("read") });
			const request = requestFor(component, [
				{ action: "tool.invoke", resource: `tool://tool/read@${component.sourceDigest}` },
				{ action: "fs.read", resource: `file://${workspace.replace(/\\/g, "/")}/src/a${index}.ts` },
			]);
			const filePattern = `file://${workspace.replace(/\\/g, "/")}/src/**`;
			const base = internalPolicy({
				enabledTools: ["read"],
				permits: [{ id: "workspace-read", actions: ["tool.invoke", "fs.read"], resources: ["tool://**", filePattern] }],
			});
			const baseDecision = evaluateAuthorization(request, base).kind;
			const tightened = internalPolicy({
				enabledTools: ["read"],
				permits: base.permits.rules,
				paths: [{ match: path.join(workspace, "src", "**"), ceiling: { agents: [], tools: [] } }],
			});
			expect(allows(evaluateAuthorization(request, tightened).kind)).toBeLessThanOrEqual(allows(baseDecision));
			const forbid = internalPolicy({
				enabledTools: ["read"],
				permits: base.permits.rules,
				forbids: [{ id: "no-src-read", actions: ["fs.read"], resources: [filePattern] }],
			});
			expect(allows(evaluateAuthorization(request, forbid).kind)).toBeLessThanOrEqual(allows(baseDecision));
			const consent = { ...tightened, consent: { rules: [{ actions: ["fs.read"], resources: ["*"], mode: "ask" as const }] } };
			expect(evaluateAuthorization(request, consent).kind).toBe("deny");
		}
	});
});

function internalPolicy(input: {
	enabledTools: readonly string[];
	permits?: CompiledSecurityPolicy["permits"]["rules"];
	forbids?: CompiledSecurityPolicy["forbids"]["rules"];
	paths?: CompiledSecurityPolicy["boundaries"]["paths"];
}): CompiledSecurityPolicy {
	return {
		componentEnablement: {
			defaultComponent: "disabled",
			global: { tools: input.enabledTools, bash: false, mcp: [], skills: [], agents: ["main"] },
			agents: { main: { tools: input.enabledTools, bash: false, mcp: [], skills: [], agents: [] } },
		},
		boundaries: { defaultAuthorization: "deny", paths: input.paths ?? [] },
		forbids: { rules: input.forbids ?? [] },
		permits: { rules: input.permits ?? [] },
		consent: { rules: [] },
	};
}

function noUi() {
	return { hasUI: false, timeoutMs: 1, prompt: async () => "deny" as const };
}

function requestFor(component: ComponentIdentity, atoms: AuthorizationRequest["atoms"]): AuthorizationRequest {
	const principal = defaultPrincipal({ sessionId: "s", workspaceRoot: workspace });
	return {
		requestId: "r",
		executionId: "e",
		principal,
		component,
		exactness: "exact",
		inputDigest: digest({}),
		atoms,
		context: {
			workspaceId: digest(workspace),
			scopeUri: `file://${workspace.replace(/\\/g, "/")}`,
			interactive: false,
			policyDigest: "p",
			registryDigest: "r",
			timestamp: 0,
		},
	};
}

function callFor(service: SecurityService, executionId: string, component: ComponentIdentity, input: unknown): ImmutableExecutionCall {
	return {
		executionId,
		principal: service.principal(),
		component,
		input,
		context: { workspaceRoot: workspace, agentDir, interactive: false },
	};
}

function allows(kind: "allow" | "ask" | "deny"): number {
	if (kind === "allow") return 2;
	if (kind === "ask") return 1;
	return 0;
}
