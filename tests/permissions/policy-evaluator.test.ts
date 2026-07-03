import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readWorkspaceFile } from "../../src/file-tools/read-tool.js";
import { editWorkspace } from "../../src/file-tools/edit-tool.js";
import { tempEnv, service, noUi, prompt, type TempEnv } from "./helpers.js";

let env: TempEnv;

beforeEach(async () => {
	env = await tempEnv();
});

afterEach(async () => {
	await env.cleanup();
});

describe("policy evaluator", () => {
	it("workspace root 默认允许 read", async () => {
		await writeFile(path.join(env.workspace, "a.txt"), "a\n");
		await expect(readWorkspaceFile(env.workspace, { path: "a.txt" }, { permissionService: service(env), toolCallId: "r", promptContext: noUi() })).resolves.toMatchObject({ content: "a\n" });
	});

	it("root 外访问 ask，无 UI 时拒绝", async () => {
		const file = path.join(env.outside, "a.txt");
		await writeFile(file, "a\n");
		await expect(readWorkspaceFile(env.workspace, { path: file }, { permissionService: service(env), toolCallId: "r", promptContext: noUi() })).resolves.toMatchObject({ status: "failed", error: { code: "PERMISSION_PROMPT_UNAVAILABLE" } });
	});

	it("unrestricted 不覆盖用户显式 deny", async () => {
		const file = path.join(env.workspace, "secret.txt");
		await writeFile(file, "x\n");
		const globalPath = path.join(env.agentDir, "permissions.jsonc");
		await writeFile(globalPath, JSON.stringify({ version: 1, profile: "unrestricted", files: { rules: { deny: [{ paths: [file.replace(/\\/g, "/")], access: ["read"] }] } } }));
		await expect(readWorkspaceFile(env.workspace, { path: file }, { permissionService: service(env, { globalPolicyPath: globalPath }), toolCallId: "r", promptContext: prompt("allow-once") })).resolves.toMatchObject({ status: "failed", error: { code: "PERMISSION_DENIED" } });
	});

	it("全局工具 deny 不被文件 root allow 覆盖", async () => {
		const file = path.join(env.workspace, "a.txt");
		await writeFile(file, "a\n");
		const globalPath = path.join(env.agentDir, "permissions.jsonc");
		await writeFile(globalPath, JSON.stringify({ version: 1, tools: { items: { read: "deny" } }, files: { roots: [{ path: "${workspace}", access: "read-write" }] } }));
		await expect(readWorkspaceFile(env.workspace, { path: "a.txt" }, { permissionService: service(env, { globalPolicyPath: globalPath }), toolCallId: "r", promptContext: prompt("allow-once") })).resolves.toMatchObject({ status: "failed", error: { code: "PERMISSION_DENIED" } });
	});

	it("全局工具 ask 不被文件 root allow 覆盖", async () => {
		const file = path.join(env.workspace, "a.txt");
		await writeFile(file, "a\n");
		const globalPath = path.join(env.agentDir, "permissions.jsonc");
		await writeFile(globalPath, JSON.stringify({ version: 1, tools: { items: { read: "ask" } }, files: { roots: [{ path: "${workspace}", access: "read-write" }] } }));
		await expect(readWorkspaceFile(env.workspace, { path: "a.txt" }, { permissionService: service(env, { globalPolicyPath: globalPath }), toolCallId: "r", promptContext: noUi() })).resolves.toMatchObject({ status: "failed", error: { code: "PERMISSION_PROMPT_UNAVAILABLE" } });
	});

	it("重叠 root 使用最长 canonical path，不依赖配置顺序", async () => {
		const secretDir = path.join(env.workspace, "secret");
		const file = path.join(secretDir, "a.txt");
		await mkdir(secretDir);
		await writeFile(file, "a\n");
		const globalPath = path.join(env.agentDir, "permissions.jsonc");
		await writeFile(globalPath, JSON.stringify({ version: 1, files: { roots: [{ path: "${workspace}", access: "read-write" }, { path: secretDir, access: "read-only" }] } }));
		const runtime = service(env, { globalPolicyPath: globalPath });
		const read = await readWorkspaceFile(env.workspace, { path: file }, { permissionService: runtime, toolCallId: "r", promptContext: noUi() });
		if (!("version" in read)) throw new Error("read failed");
		await expect(editWorkspace(env.workspace, { operations: [{ type: "replace_file", path: file, base_version: read.version, content: "b\n" }] }, { permission: { permissionService: runtime, toolCallId: "e", promptContext: noUi() } })).resolves.toMatchObject({ status: "failed", error: { code: "PERMISSION_PROMPT_UNAVAILABLE" } });
	});

	it("相同长度 root 使用更严格权限", async () => {
		const file = path.join(env.workspace, "a.txt");
		await writeFile(file, "a\n");
		const globalPath = path.join(env.agentDir, "permissions.jsonc");
		await writeFile(globalPath, JSON.stringify({ version: 1, files: { roots: [{ path: "${workspace}", access: "read-write" }, { path: env.workspace, access: "read-only" }] } }));
		const runtime = service(env, { globalPolicyPath: globalPath });
		const read = await readWorkspaceFile(env.workspace, { path: "a.txt" }, { permissionService: runtime, toolCallId: "r", promptContext: noUi() });
		if (!("version" in read)) throw new Error("read failed");
		await expect(editWorkspace(env.workspace, { operations: [{ type: "replace_file", path: "a.txt", base_version: read.version, content: "b\n" }] }, { permission: { permissionService: runtime, toolCallId: "e", promptContext: noUi() } })).resolves.toMatchObject({ status: "failed", error: { code: "PERMISSION_PROMPT_UNAVAILABLE" } });
	});

	it("read-only 根据 operation 拒绝写入", async () => {
		const file = path.join(env.workspace, "a.txt");
		await writeFile(file, "a\n");
		const globalPath = path.join(env.agentDir, "permissions.jsonc");
		await writeFile(globalPath, JSON.stringify({ version: 1, profile: "read-only" }));
		const read = await readWorkspaceFile(env.workspace, { path: "a.txt" }, { permissionService: service(env, { globalPolicyPath: globalPath }), toolCallId: "r", promptContext: noUi() });
		if (!("version" in read)) throw new Error("read failed");
		await expect(editWorkspace(env.workspace, { operations: [{ type: "replace_file", path: "a.txt", base_version: read.version, content: "b\n" }] }, { permission: { permissionService: service(env, { globalPolicyPath: globalPath }), toolCallId: "e", promptContext: prompt("allow-once") } })).resolves.toMatchObject({ status: "failed", error: { code: "PERMISSION_DENIED" } });
	});
});
