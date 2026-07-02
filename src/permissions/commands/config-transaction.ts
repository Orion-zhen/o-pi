import { createHash } from "node:crypto";
import { open, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { applyEdits, modify, parse } from "jsonc-parser";

import { defaultPermissionConfig, loadPolicy, permissionsSchema, validateProjectConfig } from "../policy.js";
import type { FileRootAccess, PermissionEffect, PermissionProfile, PermissionSubjectKind, PolicyDiagnostic } from "../permission-types.js";
import type { PermissionService } from "../permission-service.js";
import { PermissionCommandError } from "./permission-command.js";

/** 事务服务支持的最小策略变更集合；不暴露内部 IR。 */
export type PolicyMutation =
	| { type: "set-subject"; kind: "tool" | "mcp-tool" | "skill" | "agent"; key: string; decision: PermissionEffect }
	| { type: "reset-subject"; kind: "tool" | "mcp-tool" | "skill" | "agent"; key: string }
	| { type: "add-root"; rootPath: string; access: FileRootAccess }
	| { type: "remove-root"; index: number }
	| { type: "set-profile"; profile: PermissionProfile };

/** 策略写入结果摘要；不包含完整配置文本。 */
export interface PolicyMutationResult {
	filePath: string;
	beforeGeneration: number;
	afterGeneration: number;
	summary: string;
	diagnostics: PolicyDiagnostic[];
}

/** 权限配置唯一写入通道：JSONC 局部修改、乐观并发、验证、临时文件和原子替换。 */
export class PermissionConfigurationTransactionService {
	constructor(private readonly runtime: PermissionService) {}

	async updateGlobal(mutation: PolicyMutation): Promise<PolicyMutationResult> {
		const before = await this.runtime.getPolicySnapshot();
		const filePath = before.global.path;
		const original = await readPolicyOrDefault(filePath);
		const signature = await fileSignature(filePath);
		const updated = applyMutation(original, mutation);
		const diagnostics = await validateTempPolicy(filePath, updated, "global");
		if (diagnostics.length > 0) {
			throw new PermissionCommandError("PERMISSION_POLICY_INVALID", formatTransactionDiagnostics(diagnostics));
		}
		if ((await fileSignature(filePath)) !== signature) {
			throw new PermissionCommandError("PERMISSION_POLICY_CONFLICT", "Policy changed on disk while this command was running. Reload and retry.");
		}
		await atomicWrite(filePath, updated);
		await writeSchema(path.join(path.dirname(filePath), "permissions.schema.json"));
		const after = await this.runtime.reloadPolicy();
		return {
			filePath,
			beforeGeneration: before.generation,
			afterGeneration: after.generation,
			summary: mutationSummary(mutation),
			diagnostics: [],
		};
	}

	async replacePolicy(scope: "global" | "project", text: string): Promise<PolicyMutationResult> {
		const before = await this.runtime.getPolicySnapshot();
		const filePath = scope === "global" ? before.global.path : before.project.path;
		const signature = await fileSignature(filePath);
		const diagnostics = await validateTempPolicy(filePath, text, scope);
		if (diagnostics.length > 0) throw new PermissionCommandError("PERMISSION_POLICY_INVALID", formatTransactionDiagnostics(diagnostics));
		if ((await fileSignature(filePath)) !== signature) {
			throw new PermissionCommandError("PERMISSION_POLICY_CONFLICT", "Policy changed on disk while this command was running. Reload and retry.");
		}
		await atomicWrite(filePath, text);
		const after = await this.runtime.reloadPolicy();
		return {
			filePath,
			beforeGeneration: before.generation,
			afterGeneration: after.generation,
			summary: `replace ${scope} policy`,
			diagnostics: [],
		};
	}
}

function applyMutation(text: string, mutation: PolicyMutation): string {
	const formattingOptions = { insertSpaces: false, tabSize: 1, eol: "\n" };
	if (mutation.type === "set-profile") {
		return applyEdits(text, modify(text, ["profile"], mutation.profile, { formattingOptions }));
	}
	if (mutation.type === "add-root") {
		const config = parse(text, [], { allowTrailingComma: true, disallowComments: false }) as { files?: { roots?: unknown[] } } | undefined;
		const index = config?.files?.roots?.length ?? 0;
		return applyEdits(text, modify(text, ["files", "roots", index], { path: mutation.rootPath, access: mutation.access }, { formattingOptions, getInsertionIndex: () => index }));
	}
	if (mutation.type === "remove-root") {
		return applyEdits(text, modify(text, ["files", "roots", mutation.index], undefined, { formattingOptions }));
	}
	const targetPath = subjectPointer(mutation.kind, mutation.key);
	if (mutation.type === "set-subject") return applyEdits(text, modify(text, targetPath, mutation.decision, { formattingOptions }));
	return applyEdits(text, modify(text, targetPath, undefined, { formattingOptions }));
}

function subjectPointer(kind: PermissionSubjectKind, key: string): (string | number)[] {
	if (kind === "tool") return ["tools", "items", key];
	if (kind === "skill") return ["skills", "items", key];
	if (kind === "agent") return ["agents", "items", key];
	const [server, tool] = key.split("/", 2);
	if (server === undefined || tool === undefined) throw new PermissionCommandError("PERMISSION_COMMAND_INVALID_ARGUMENT", `Invalid MCP subject: ${key}`);
	return ["mcp", "servers", server, "tools", tool];
}

async function readPolicyOrDefault(filePath: string): Promise<string> {
	try {
		return await readFile(filePath, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return `${JSON.stringify(defaultPermissionConfig(), null, "\t")}\n`;
		}
		throw error;
	}
}

async function validateTempPolicy(filePath: string, text: string, source: "global" | "project"): Promise<PolicyDiagnostic[]> {
	const temp = `${filePath}.${process.pid}.${Date.now()}.validate.tmp`;
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(temp, text, "utf8");
	try {
		const loaded = await loadPolicy(source, temp);
		if (source === "project" && loaded.config !== undefined) return [...loaded.diagnostics, ...validateProjectConfig(temp, loaded.config)];
		return loaded.diagnostics;
	} finally {
		await import("node:fs/promises").then((fs) => fs.rm(temp, { force: true })).catch(() => undefined);
	}
}

async function atomicWrite(filePath: string, text: string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temp, text, "utf8");
	const handle = await open(temp, "r");
	try {
		await handle.sync().catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && (error.code === "EINVAL" || error.code === "EPERM")) return;
			throw error;
		});
	} finally {
		await handle.close();
	}
	await rename(temp, filePath);
}

async function writeSchema(filePath: string): Promise<void> {
	await writeFile(filePath, `${JSON.stringify(permissionsSchema, null, "\t")}\n`, "utf8").catch(() => undefined);
}

async function fileSignature(filePath: string): Promise<string> {
	try {
		const [info, text] = await Promise.all([stat(filePath), readFile(filePath)]);
		return createHash("sha256").update(text).update(String(info.mtimeMs)).update(String(info.size)).digest("hex");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "missing";
		throw error;
	}
}

function mutationSummary(mutation: PolicyMutation): string {
	if (mutation.type === "set-subject") return `${mutation.kind} ${mutation.key} -> ${mutation.decision}`;
	if (mutation.type === "reset-subject") return `${mutation.kind} ${mutation.key} reset`;
	if (mutation.type === "add-root") return `add root ${mutation.rootPath} ${mutation.access}`;
	if (mutation.type === "remove-root") return `remove root #${mutation.index}`;
	return `profile -> ${mutation.profile}`;
}

function formatTransactionDiagnostics(diagnostics: PolicyDiagnostic[]): string {
	return diagnostics.slice(0, 100).map((item) => `${item.file}${item.pointer}:${item.line}:${item.column} ${item.message}`).join("\n");
}
