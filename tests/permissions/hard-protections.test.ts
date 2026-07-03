import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readWorkspaceFile } from "../../src/file-tools/read-tool.js";
import { tempEnv, service, prompt, noUi, type TempEnv } from "./helpers.js";

let env: TempEnv;

beforeEach(async () => {
	env = await tempEnv();
});

afterEach(async () => {
	await env.cleanup();
});

describe("hard protections", () => {
	it("Pi auth 文件不可读且不可审批覆盖", async () => {
		await mkdir(env.agentDir, { recursive: true });
		await writeFile(path.join(env.agentDir, "auth.json"), "{\"token\":\"secret\"}\n");
		await expect(readWorkspaceFile(env.workspace, { path: path.join(env.agentDir, "auth.json") }, { permissionService: service(env), toolCallId: "r", promptContext: prompt("allow-once") })).resolves.toMatchObject({ status: "failed", error: { code: "PERMISSION_HARD_DENIED" } });
	});

	it("权限状态目录不可通过文件工具读取", async () => {
		const grants = path.join(env.agentDir, "permission-state", "grants.json");
		await mkdir(path.dirname(grants), { recursive: true });
		await writeFile(grants, "[]\n");
		await expect(readWorkspaceFile(env.workspace, { path: grants }, { permissionService: service(env), toolCallId: "r", promptContext: prompt("allow-once") })).resolves.toMatchObject({ status: "failed", error: { code: "PERMISSION_HARD_DENIED" } });
	});

	it("保护路径自身为 symlink 时直接访问 canonical target 仍被拒绝", async () => {
		const target = path.join(env.outside, "target-auth.json");
		const auth = path.join(env.agentDir, "auth.json");
		await writeFile(target, "{\"token\":\"secret\"}\n");
		await mkdir(env.agentDir, { recursive: true });
		await symlink(target, auth, "file");
		await expect(readWorkspaceFile(env.workspace, { path: target }, { permissionService: service(env), toolCallId: "r", promptContext: prompt("allow-once") })).resolves.toMatchObject({ status: "failed", error: { code: "PERMISSION_HARD_DENIED" } });
	});

	it("初始化时不存在的保护路径之后被创建也按 lexical 路径拒绝", async () => {
		const runtime = service(env);
		const outside = path.join(env.outside, "ordinary.txt");
		await writeFile(outside, "ok\n");
		await readWorkspaceFile(env.workspace, { path: outside }, { permissionService: runtime, toolCallId: "warmup", promptContext: prompt("allow-once") });
		const auth = path.join(env.agentDir, "auth.json");
		await mkdir(env.agentDir, { recursive: true });
		await writeFile(auth, "{\"token\":\"secret\"}\n");
		await expect(readWorkspaceFile(env.workspace, { path: auth }, { permissionService: runtime, toolCallId: "r", promptContext: noUi() })).resolves.toMatchObject({ status: "failed", error: { code: "PERMISSION_HARD_DENIED" } });
	});
});
