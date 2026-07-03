import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tempEnv, type TempEnv } from "./helpers.js";
import { PermissionService } from "../../src/permissions/permission-service.js";
import { policyDoctorView } from "../../src/permissions/commands/application-service.js";

let env: TempEnv;

beforeEach(async () => {
	env = await tempEnv();
});

afterEach(async () => {
	await env.cleanup();
});

describe("policy compiler", () => {
	it("项目策略拒绝 profile、roots、outsideRoots 和 allow", async () => {
		const projectPath = path.join(env.workspace, ".pi", "permissions.jsonc");
		await mkdir(path.dirname(projectPath), { recursive: true });
		await writeFile(projectPath, JSON.stringify({ version: 1, profile: "unrestricted", files: { roots: [], outsideRoots: { read: "allow" }, rules: { allow: [{ paths: ["x"], access: ["read"] }] } }, mcp: { servers: { demo: { tools: { run: "allow" } } } } }));
		const service = new PermissionService({ workspaceRoot: env.workspace, agentDir: env.agentDir, projectTrusted: true, projectPolicyPath: projectPath });
		const status = await service.status();
		expect(status.projectPolicy.status).toBe("invalid");
		expect(status.projectPolicy.diagnostics.map((item) => item.pointer)).toEqual(expect.arrayContaining(["/profile", "/files/roots", "/files/outsideRoots", "/files/rules/allow", "/mcp"]));
	});

	it("未知路径变量导致 fail closed", async () => {
		const globalPath = path.join(env.agentDir, "permissions.jsonc");
		await writeFile(globalPath, JSON.stringify({ version: 1, files: { roots: [{ path: "${bad}", access: "read-write" }] } }));
		const service = new PermissionService({ workspaceRoot: env.workspace, agentDir: env.agentDir, projectTrusted: false, globalPolicyPath: globalPath });
		const result = await service.authorizeSubjectCall({ kind: "tool", configKey: "read", input: { path: "." }, executionId: "read", promptContext: { hasUI: false, timeoutMs: 1, prompt: async () => ({ decision: "deny" }) } });
		expect(result).toMatchObject({ allowed: false, error: { code: "PERMISSION_POLICY_INVALID" } });
		await expect(policyDoctorView(service)).resolves.toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: "P404" })]) });
	});

	it("policy doctor 报告重复、覆盖和权限相反的重叠 root", async () => {
		const secret = path.join(env.workspace, "secret");
		await mkdir(secret);
		const globalPath = path.join(env.agentDir, "permissions.jsonc");
		await writeFile(globalPath, JSON.stringify({ version: 1, files: { roots: [{ path: "${workspace}", access: "read-write" }, { path: env.workspace, access: "read-only" }, { path: secret, access: "read-only" }] } }));
		const service = new PermissionService({ workspaceRoot: env.workspace, agentDir: env.agentDir, projectTrusted: false, globalPolicyPath: globalPath });
		const view = await policyDoctorView(service);
		expect(view.findings.map((item) => item.code)).toEqual(expect.arrayContaining(["P401", "P402", "P403"]));
	});
});
