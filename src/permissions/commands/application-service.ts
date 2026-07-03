import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Grant } from "../grants.js";
import type {
	CompiledDecision,
	FileRootAccess,
	PermissionAuditEntry,
	PermissionEffect,
	PermissionProfile,
	PermissionResource,
	PermissionSubjectKind,
	PolicySnapshot,
	PolicyDiagnostic,
} from "../permission-types.js";
import { fileRootAccesses, permissionEffects, permissionProfiles } from "../permission-types.js";
import { isPathInside, normalizeUserPath } from "../path-utils.js";
import type { PermissionService } from "../permission-service.js";
import { PermissionConfigurationTransactionService } from "./config-transaction.js";
import { PermissionCommandError } from "./permission-command.js";

/** 命令和交互页面共享的 application service 集合。 */
export interface PermissionApplicationServices {
	runtime: PermissionService;
	config: PermissionConfigurationTransactionService;
}

/** 为单个 runtime 创建命令服务边界。 */
export function createPermissionApplicationServices(runtime: PermissionService): PermissionApplicationServices {
	return { runtime, config: new PermissionConfigurationTransactionService(runtime) };
}

/** 构造 status DTO；不展开明细规则。 */
export async function statusView(runtime: PermissionService) {
	const status = await runtime.getStatus();
	const snapshot = await runtime.getPolicySnapshot();
	return {
		profile: {
			configured: snapshot.globalConfig?.profile ?? "standard",
			effective: status.profile,
		},
		policies: {
			global: policyStatus(status.globalPolicy),
			project: policyStatus(status.projectPolicy),
			projectTrusted: status.projectTrusted,
		},
		generations: { policy: status.policyGeneration, registry: status.registryGeneration },
		subjectCounts: subjectCounts(runtime),
		roots: {
			readOnly: snapshot.roots.filter((root) => root.access === "read-only").length,
			readWrite: snapshot.roots.filter((root) => root.access === "read-write").length,
		},
		grants: {
			session: status.sessionGrantCount,
			persistent: status.persistentGrantCount,
			suspended: (await runtime.listSuspendedGrants()).length,
		},
		maintenance: { enabled: status.maintenance },
		audit: { enabled: status.auditEnabled, lastError: status.recentErrors.find((item) => item.startsWith("audit:")) },
		recentErrors: status.recentErrors,
	};
}

/** 构造主体 catalog DTO，来源为实际注册表。 */
export function catalogView(runtime: PermissionService, filter?: string) {
	const entries = runtime.getRegistrySnapshot().filter((entry) => {
		if (filter === undefined) return true;
		if (filter === "tools") return entry.kind === "tool";
		return entry.configKey.includes(filter) || entry.displayName.includes(filter) || entry.qualifiedConfigKey.includes(filter);
	});
	return { entries };
}

/** 构造 explain DTO；只模拟，不创建 lease/grant/审批。 */
export async function explainView(runtime: PermissionService, subjectText: string | undefined, args: readonly string[]) {
	if (subjectText === undefined) {
		return { subject: undefined, decision: undefined, message: "Provide a subject to explain." };
	}
	const subject = resolveSubject(runtime, subjectText);
	const input = inputForSubject(subject.configKey, args);
	const decision = await runtime.explainSubjectCall({ kind: subject.kind, configKey: subject.configKey, subjectId: subject.id, input });
	const resources = resourceViews(await resourcesForExplain(runtime, subject.kind, subject.configKey, input), decision);
	return { subject, input, decision, resources };
}

/** 列出当前有效文件 roots，包括 session root。 */
export async function rootsView(runtime: PermissionService) {
	const roots = await runtime.listFileRoots();
	return {
		roots: roots.map((root, index) => ({
			id: `global:${index}`,
			path: root.canonicalPath,
			access: root.access,
			source: root.source,
		})),
	};
}

/** 通过事务服务新增全局 root。 */
export async function addGlobalRoot(runtime: PermissionService, rootPath: string, access: string) {
	assertRootAccess(access);
	const services = createPermissionApplicationServices(runtime);
	return await services.config.updateGlobal({ type: "add-root", rootPath, access });
}

/** 通过事务服务删除全局 root。 */
export async function removeGlobalRoot(runtime: PermissionService, rootId: string) {
	const index = rootIndex(rootId);
	const roots = await runtime.listFileRoots();
	if (roots[index] === undefined) throw new PermissionCommandError("PERMISSION_ROOT_NOT_FOUND", `Root not found: ${rootId}`);
	const services = createPermissionApplicationServices(runtime);
	return await services.config.updateGlobal({ type: "remove-root", index });
}

/** 列出 session、persistent、suspended grants，身份信息只展示绑定状态。 */
export async function grantsView(runtime: PermissionService) {
	const [session, persistent, suspended] = await Promise.all([runtime.listSessionGrants(), runtime.listPersistentGrants(), runtime.listSuspendedGrants()]);
	return { session: grantViews(session), persistent: grantViews(persistent), suspended: grantViews(suspended) };
}

/** 获取单个 grant 的脱敏视图。 */
export async function grantView(runtime: PermissionService, id: string) {
	const grants = await grantsView(runtime);
	const all = [...grants.session, ...grants.persistent, ...grants.suspended];
	const grant = all.find((item) => item.id === id);
	if (grant === undefined) throw new PermissionCommandError("PERMISSION_GRANT_NOT_FOUND", `Grant not found: ${id}`);
	return { grant };
}

/** 构造 policy validate DTO；不修改文件也不 reload。 */
export async function policyValidateView(runtime: PermissionService, scope: "global" | "project" | "all") {
	const snapshot = await runtime.getPolicySnapshot();
	const diagnostics = snapshot.diagnostics.filter((item) => scope === "all" || (scope === "global" ? item.file === snapshot.global.path : item.file === snapshot.project.path));
	return { scope, valid: diagnostics.length === 0, diagnostics };
}

/** 构造语义诊断 DTO；默认只报告，不自动修复。 */
export async function policyDoctorView(runtime: PermissionService) {
	const snapshot = await runtime.getPolicySnapshot();
	const findings = [
		...snapshot.diagnostics.map(diagnosticFinding),
		...(snapshot.profile === "unrestricted"
			? [{
					code: "P201",
					severity: "warning" as const,
					title: "Unrestricted profile is configured",
					message: "Unconfigured requests default to allow.",
					sourcePath: snapshot.global.path,
					jsonPointer: "/profile",
					remediation: "Use standard unless this is intentional.",
				}]
			: []),
		...(snapshot.auditEnabled ? [] : [{
			code: "P301",
			severity: "warning" as const,
			title: "Audit is disabled",
			message: "Permission decisions will not be written to the audit log.",
			sourcePath: snapshot.global.path,
			jsonPointer: "/audit/enabled",
			remediation: "Set audit.enabled to true.",
		}]),
		...rootPolicyFindings(snapshot),
	];
	return { findings };
}

/** 展示原始 policy 或用户语义化 effective 摘要。 */
export async function policyShowView(runtime: PermissionService, scope: "global" | "project" | "effective") {
	const snapshot = await runtime.getPolicySnapshot();
	if (scope === "effective") {
		return {
			scope,
			effective: {
				profile: snapshot.profile,
				roots: snapshot.roots,
				tools: snapshot.globalConfig?.tools,
				projectRestrictions: snapshot.projectConfig,
				source: ["profile", "global", snapshot.project.status === "loaded" ? "project" : undefined].filter(Boolean),
			},
		};
	}
	const filePath = scope === "global" ? snapshot.global.path : snapshot.project.path;
	return { scope, path: filePath, text: await readFile(filePath, "utf8").catch(() => "") };
}

/** 读取最近审计记录，使用 AuditLogger 的脱敏内容。 */
export async function auditTailView(runtime: PermissionService, count: number) {
	return { entries: (await runtime.getRecentAuditEntries(count)).map(auditEntryView) };
}

/** 按 request/lease/grant id 查找单条审计记录。 */
export async function auditShowView(runtime: PermissionService, id: string) {
	const entry = await runtime.getAuditEntry(id);
	if (entry === undefined) throw new PermissionCommandError("PERMISSION_COMMAND_INVALID_ARGUMENT", `Audit entry not found: ${id}`);
	return { entry: auditEntryView(entry) };
}

/** 校验 allow/ask/deny 参数。 */
export function assertEffect(value: string): asserts value is PermissionEffect {
	if (!(permissionEffects as readonly string[]).includes(value)) {
		throw new PermissionCommandError("PERMISSION_COMMAND_INVALID_ARGUMENT", `Expected allow, ask, or deny; got ${value}`);
	}
}

/** 校验 profile 参数。 */
export function assertProfile(value: string): asserts value is PermissionProfile {
	if (!(permissionProfiles as readonly string[]).includes(value)) {
		throw new PermissionCommandError("PERMISSION_COMMAND_INVALID_ARGUMENT", `Unknown profile: ${value}`);
	}
}

/** 校验 root access 参数。 */
export function assertRootAccess(value: string): asserts value is FileRootAccess {
	if (!(fileRootAccesses as readonly string[]).includes(value)) {
		throw new PermissionCommandError("PERMISSION_COMMAND_INVALID_ARGUMENT", `Expected read-only or read-write; got ${value}`);
	}
}

/** 解析用户可见主体名称；模糊时返回候选错误，不随机选择。 */
export function resolveSubject(runtime: PermissionService, text: string) {
	const catalog = runtime.getRegistrySnapshot();
	const parsed = parseSubjectText(text);
	const candidates = catalog.filter((entry) => {
		if (parsed.kind !== undefined && entry.kind !== parsed.kind) return false;
		return entry.configKey === parsed.key || entry.qualifiedConfigKey === text || entry.id === text;
	});
	if (candidates.length === 1) return candidates[0] ?? unreachable();
	if (candidates.length > 1) throw new PermissionCommandError("PERMISSION_COMMAND_AMBIGUOUS_SUBJECT", `Subject "${text}" is ambiguous.`, candidates.map((item) => item.qualifiedConfigKey));
	throw new PermissionCommandError("PERMISSION_UNKNOWN_SUBJECT", `Unknown permission subject: ${text}`, catalog.map((item) => item.qualifiedConfigKey).filter((item) => item.includes(parsed.key)).slice(0, 5));
}

/** 将 set/reset 的用户主体解析为 policy 写入位置。 */
export function subjectKindForSet(runtime: PermissionService, text: string): { kind: PermissionSubjectKind; key: string } {
	const subject = resolveSubject(runtime, text);
	return { kind: subject.kind, key: subject.configKey };
}

/** 使用 runtime workspace/agentDir 规范化用户输入路径。 */
export function normalizeRootInput(runtime: PermissionService, inputPath: string): string {
	const options = runtime.getOptions();
	return normalizeUserPath(options.workspaceRoot, inputPath, options.agentDir);
}

function policyStatus(policy: { path: string; status: string; diagnostics: PolicyDiagnostic[] }) {
	return { path: policy.path, status: policy.status === "loaded" || policy.status === "missing" ? "valid" : policy.status, diagnostics: policy.diagnostics };
}

function diagnosticFinding(diagnostic: PolicyDiagnostic) {
	const rootCanonicalize = diagnostic.message.startsWith("Cannot canonicalize root ");
	return {
		code: rootCanonicalize ? "P404" : "P001",
		severity: "error" as const,
		title: rootCanonicalize ? "File root cannot be canonicalized" : "Policy is invalid",
		message: diagnostic.message,
		sourcePath: diagnostic.file,
		jsonPointer: diagnostic.pointer,
		remediation: rootCanonicalize ? "Use an existing directory path for this root." : "Edit the policy and validate again.",
	};
}

function rootPolicyFindings(snapshot: PolicySnapshot) {
	const findings: Array<{
		code: string;
		severity: "warning";
		title: string;
		message: string;
		sourcePath: string;
		jsonPointer: string;
		remediation: string;
	}> = [];
	for (let leftIndex = 0; leftIndex < snapshot.roots.length; leftIndex += 1) {
		const left = snapshot.roots[leftIndex];
		if (left === undefined) continue;
		for (let rightIndex = leftIndex + 1; rightIndex < snapshot.roots.length; rightIndex += 1) {
			const right = snapshot.roots[rightIndex];
			if (right === undefined) continue;
			if (left.canonicalPath === right.canonicalPath) {
				findings.push({
					code: "P401",
					severity: "warning",
					title: "Duplicate file root",
					message: `Root ${rightIndex} duplicates root ${leftIndex}: ${right.canonicalPath}.`,
					sourcePath: snapshot.global.path,
					jsonPointer: "/files/roots",
					remediation: "Keep one root for each canonical path.",
				});
				findings.push({
					code: "P402",
					severity: "warning",
					title: "File root is fully covered",
					message: `Root ${rightIndex} is fully covered by root ${leftIndex}: ${right.canonicalPath}.`,
					sourcePath: snapshot.global.path,
					jsonPointer: "/files/roots",
					remediation: "Remove the covered root.",
				});
			}
			if (left.access !== right.access && (isPathInside(left.canonicalPath, right.canonicalPath) || isPathInside(right.canonicalPath, left.canonicalPath))) {
				findings.push({
					code: "P403",
					severity: "warning",
					title: "Overlapping roots use different access",
					message: `Root ${leftIndex} (${left.access}) overlaps root ${rightIndex} (${right.access}). The longest canonical path wins.`,
					sourcePath: snapshot.global.path,
					jsonPointer: "/files/roots",
					remediation: "Keep overlapping roots only when the narrower path intentionally changes access.",
				});
			}
		}
	}
	return findings;
}

function subjectCounts(runtime: PermissionService) {
	const entries = runtime.getRegistrySnapshot();
	return {
		tools: entries.filter((entry) => entry.kind === "tool").length,
	};
}

function inputForSubject(subjectKey: string, args: readonly string[]): unknown {
	const first = args[0] ?? ".";
	if (subjectKey === "read" || subjectKey === "ls") return { path: first };
	if (subjectKey === "edit") return { operations: [{ type: "update_file", path: first, replacements: [] }] };
	if (subjectKey === "bash") return { command: args.join(" ") };
	return {};
}

async function resourcesForExplain(runtime: PermissionService, kind: PermissionSubjectKind, subjectKey: string, input: unknown): Promise<PermissionResource[]> {
	const descriptor = runtime.getRegistry().resolve(kind, subjectKey);
	if (descriptor === undefined) return [];
	const options = runtime.getOptions();
	return (await descriptor.analyze(input, { workspaceRoot: options.workspaceRoot, agentDir: options.agentDir })).resources;
}

function resourceViews(resources: PermissionResource[], _decision: CompiledDecision) {
	return resources.map((resource) => {
		if (resource.kind === "file") {
			return {
				kind: resource.kind,
				input: resource.inputPath,
				lexical: resource.lexicalAbsolutePath,
				canonical: resource.canonicalPath,
				symlink: resource.viaSymlink,
				access: resource.access,
				operation: resource.operation,
			};
		}
		return resource;
	});
}

function grantViews(grants: Grant[]) {
	return grants.map((grant) => ({
		id: grant.id,
		subjectId: grant.subjectId,
		scopes: grant.scopes,
		createdAt: new Date(grant.createdAt).toISOString(),
		status: grant.status,
		identity: grant.subjectIdentity === undefined ? "none" : "bound",
	}));
}

function auditEntryView(entry: PermissionAuditEntry) {
	return {
		id: entry.requestId,
		timestamp: entry.timestamp,
		subject: entry.subject.configKey,
		operations: entry.operations,
		resources: entry.resources,
		policyGeneration: entry.policyGeneration,
		registryGeneration: entry.registryGeneration,
		finalDecision: entry.finalDecision,
		source: entry.decisionSource,
		...(entry.grantIds !== undefined ? { grantIds: entry.grantIds } : {}),
		...(entry.leaseId !== undefined ? { leaseId: entry.leaseId } : {}),
		...(entry.errorCode !== undefined ? { errorCode: entry.errorCode } : {}),
	};
}

function parseSubjectText(text: string): { kind?: PermissionSubjectKind; key: string } {
	if (text.startsWith("mcp:")) return { kind: "mcp-tool", key: text.slice(4) };
	if (text.startsWith("skill:")) return { kind: "skill", key: text.slice(6) };
	if (text.startsWith("agent:")) return { kind: "agent", key: text.slice(6) };
	return { key: text };
}

function rootIndex(rootId: string): number {
	const [, rawIndex] = rootId.split(":", 2);
	const index = Number(rawIndex);
	if (!Number.isInteger(index) || index < 0) throw new PermissionCommandError("PERMISSION_ROOT_NOT_FOUND", `Root not found: ${rootId}`);
	return index;
}

function unreachable(): never {
	throw new Error("unreachable");
}
