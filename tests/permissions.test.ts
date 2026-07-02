import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editWorkspace } from "../src/file-tools/edit-tool.js";
import { listWorkspaceDirectory } from "../src/file-tools/ls-tool.js";
import { readWorkspaceFile } from "../src/file-tools/read-tool.js";
import { PermissionService } from "../src/permissions/permission-service.js";
import type { PermissionPromptContext, UserPermissionDecision } from "../src/permissions/permission-types.js";
import { accessForPath } from "../src/permissions/access-extractors.js";
import { stripJsonc } from "../src/permissions/policy-loader.js";

let workspace: string;
let outside: string;
let agentDir: string;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "o-pi-perm-workspace-"));
	outside = await mkdtemp(path.join(os.tmpdir(), "o-pi-perm-outside-"));
	agentDir = await mkdtemp(path.join(os.tmpdir(), "o-pi-perm-agent-"));
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
	await rm(agentDir, { recursive: true, force: true });
});

function prompt(decision: UserPermissionDecision["decision"], calls: string[] = []): PermissionPromptContext {
	return {
		hasUI: true,
		timeoutMs: 120000,
		prompt: async (request) => {
			calls.push(request.normalizedInputFingerprint);
			return { decision };
		},
	};
}

function noUi(): PermissionPromptContext {
	return { hasUI: false, timeoutMs: 120000, prompt: async () => ({ decision: "deny" }) };
}

describe("permissions", () => {
	it("解析 JSONC 注释和尾随逗号", () => {
		expect(JSON.parse(stripJsonc("{ // c\n \"version\": 1,\n}\n"))).toEqual({ version: 1 });
	});

	it("外部 read ask 后 Allow once 成功，下一次不保留授权", async () => {
		const file = path.join(outside, "example.txt");
		await writeFile(file, "hello\n");
		const service = new PermissionService({ workspaceRoot: workspace, agentDir });
		const first = await readWorkspaceFile(workspace, { path: file }, {
			permissionService: service,
			toolCallId: "read-1",
			promptContext: prompt("allow-once"),
		});
		expect(first).toMatchObject({ content: "hello\n" });
		const second = await readWorkspaceFile(workspace, { path: file }, {
			permissionService: service,
			toolCallId: "read-2",
			promptContext: noUi(),
		});
		expect(second).toMatchObject({ status: "failed", error: { code: "PERMISSION_PROMPT_UNAVAILABLE" } });
	});

	it("会话目录授权允许后续 read，但不允许 write", async () => {
		await writeFile(path.join(outside, "a.txt"), "a\n");
		const service = new PermissionService({ workspaceRoot: workspace, agentDir });
		const listed = await listWorkspaceDirectory(workspace, { path: outside }, {
			permissionService: service,
			toolCallId: "ls-dir",
			promptContext: prompt("allow-session-subtree"),
		});
		expect(listed).toMatchObject({ entries: [{ name: "a.txt" }] });
		expect(
			await readWorkspaceFile(workspace, { path: path.join(outside, "a.txt") }, {
				permissionService: service,
				toolCallId: "read-child",
				promptContext: noUi(),
			}),
		).toMatchObject({ content: "a\n" });
		const read = await readWorkspaceFile(workspace, { path: path.join(outside, "a.txt") }, {
			permissionService: new PermissionService({ workspaceRoot: workspace, mode: "yolo" }),
			toolCallId: "read-for-version",
			promptContext: noUi(),
		});
		if (!("version" in read)) throw new Error("read failed");
		expect(
			await editWorkspace(
				workspace,
				{ operations: [{ type: "replace_file", path: path.join(outside, "a.txt"), base_version: read.version, content: "b\n" }] },
				{ permission: { permissionService: service, toolCallId: "write-child", promptContext: noUi() } },
			),
		).toMatchObject({ status: "failed", error: { code: "PERMISSION_PROMPT_UNAVAILABLE" } });
	});

	it("外部多文件 edit 只询问一次，用户拒绝时零文件修改", async () => {
		const a = path.join(outside, "a.txt");
		const b = path.join(outside, "b.txt");
		await writeFile(b, "old\n");
		const read = await readWorkspaceFile(workspace, { path: b }, {
			permissionService: new PermissionService({ workspaceRoot: workspace, mode: "yolo" }),
			toolCallId: "read-b",
			promptContext: noUi(),
		});
		if (!("version" in read)) throw new Error("read failed");
		const calls: string[] = [];
		const result = await editWorkspace(
			workspace,
			{
				operations: [
					{ type: "create_file", path: a, content: "new\n" },
					{ type: "replace_file", path: b, base_version: read.version, content: "changed\n" },
				],
			},
			{ permission: { permissionService: new PermissionService({ workspaceRoot: workspace, agentDir }), toolCallId: "edit-many", promptContext: prompt("deny", calls) } },
		);
		expect(result).toMatchObject({ status: "failed", error: { code: "PERMISSION_DENIED_BY_USER" } });
		expect(calls).toHaveLength(1);
		await expect(readFile(a)).rejects.toThrow();
		expect(await readFile(b, "utf8")).toBe("old\n");
	});

	it("symlink 指向敏感路径时按 canonical sensitive deny", async () => {
		const sensitive = path.join(outside, "sensitive");
		await mkdir(sensitive);
		await writeFile(path.join(sensitive, "config"), "secret\n");
		try {
			await symlink(sensitive, path.join(workspace, "link"), "dir");
		} catch {
			return;
		}
		const service = new PermissionService({ workspaceRoot: workspace, agentDir, extraSensitivePaths: [sensitive] });
		expect(
			await readWorkspaceFile(workspace, { path: "link/config" }, { permissionService: service, toolCallId: "read-link", promptContext: prompt("allow-once") }),
		).toMatchObject({ status: "failed", error: { code: "PERMISSION_DENIED" } });
	});

	it("项目 allow 不能覆盖全局 deny", async () => {
		const target = path.join(outside, "denied.txt");
		await writeFile(target, "x\n");
		const globalPath = path.join(agentDir, "pi-permissions.jsonc");
		const projectPath = path.join(workspace, ".pi", "permissions.jsonc");
		await mkdir(path.dirname(projectPath), { recursive: true });
		await writeFile(globalPath, JSON.stringify({ version: 1, rules: [{ id: "deny-target", effect: "deny", tools: ["*"], resource: { type: "path", path: target, scope: "exact" } }] }));
		await writeFile(projectPath, JSON.stringify({ version: 1, rules: [{ id: "allow-target", effect: "allow", tools: ["*"], resource: { type: "path", path: target, scope: "exact" } }] }));
		const service = new PermissionService({ workspaceRoot: workspace, agentDir, globalPolicyPath: globalPath, projectPolicyPath: projectPath, projectTrusted: true });
		expect(
			await readWorkspaceFile(workspace, { path: target }, { permissionService: service, toolCallId: "read-denied", promptContext: prompt("allow-once") }),
		).toMatchObject({ status: "failed", error: { code: "PERMISSION_DENIED" } });
	});

	it("顶层 tools deny 会在 tool_call 门禁拒绝非文件工具", async () => {
		const globalPath = path.join(agentDir, "pi-permissions.jsonc");
		await writeFile(globalPath, JSON.stringify({ version: 1, tools: { bash: "deny" } }));
		const service = new PermissionService({ workspaceRoot: workspace, agentDir, globalPolicyPath: globalPath });
		await expect(
			service.authorizeToolCall({
				toolCallId: "bash-1",
				toolName: "bash",
				normalizedToolInput: { command: "pwd" },
				promptContext: noUi(),
			}),
		).resolves.toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
	});

	it("全局策略 mode 设置默认权限模式", async () => {
		const target = path.join(outside, "mode.txt");
		await writeFile(target, "x\n");
		const globalPath = path.join(agentDir, "pi-permissions.jsonc");
		await writeFile(globalPath, JSON.stringify({ version: 1, mode: "yolo" }));
		const service = new PermissionService({ workspaceRoot: workspace, agentDir, globalPolicyPath: globalPath });

		await expect(service.status()).resolves.toMatchObject({ mode: "yolo" });
		await expect(
			readWorkspaceFile(workspace, { path: target }, { permissionService: service, toolCallId: "read-yolo", promptContext: noUi() }),
		).resolves.toMatchObject({ content: "x\n" });
	});

	it("/permissions mode 运行期覆盖不会被默认 mode 重置", async () => {
		const globalPath = path.join(agentDir, "pi-permissions.jsonc");
		await writeFile(globalPath, JSON.stringify({ version: 1, mode: "yolo" }));
		const service = new PermissionService({ workspaceRoot: workspace, agentDir, globalPolicyPath: globalPath });

		await expect(service.status()).resolves.toMatchObject({ mode: "yolo" });
		service.setMode("read-only");
		await expect(service.status()).resolves.toMatchObject({ mode: "read-only" });
	});

	it("未知工具的路径策略不再按 edit 规则误判", async () => {
		await writeFile(path.join(workspace, "a.txt"), "a\n");
		const globalPath = path.join(agentDir, "pi-permissions.jsonc");
		await writeFile(globalPath, JSON.stringify({ version: 1, defaults: { workspace: { edit: "deny" } } }));
		const service = new PermissionService({ workspaceRoot: workspace, agentDir, globalPolicyPath: globalPath });
		const access = await accessForPath(service.resourceResolver, "fs.read", "a.txt");
		await expect(service.explain(access, "grep")).resolves.toMatchObject({ effect: "ask" });
	});
});
