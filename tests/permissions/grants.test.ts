import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

import { editWorkspace } from "../../src/file-tools/edit-tool.js";
import { readWorkspaceFile } from "../../src/file-tools/read-tool.js";
import { promptContextFromUi } from "../../src/permissions/permission-commands.js";
import type { AuthorizationRequest, CompiledDecision, PermissionSubject } from "../../src/permissions/permission-types.js";
import { tempEnv, service, prompt, noUi, type TempEnv } from "./helpers.js";

let env: TempEnv;

beforeEach(async () => {
	env = await tempEnv();
});

afterEach(async () => {
	await env.cleanup();
});

describe("grants", () => {
	it("allow once 只产生 lease，不进入 session grant", async () => {
		const file = path.join(env.outside, "a.txt");
		await writeFile(file, "a\n");
		const svc = service(env);
		await expect(readWorkspaceFile(env.workspace, { path: file }, { permissionService: svc, toolCallId: "r1", promptContext: prompt("allow-once") })).resolves.toMatchObject({ content: "a\n" });
		expect(svc.getSessionGrants().count()).toBe(0);
		await expect(readWorkspaceFile(env.workspace, { path: file }, { permissionService: svc, toolCallId: "r2", promptContext: noUi() })).resolves.toMatchObject({ status: "failed" });
	});

	it("session subtree grant 覆盖 child 但不覆盖 sibling root", async () => {
		const dir = path.join(env.outside, "dir");
		await import("node:fs/promises").then((fs) => fs.mkdir(dir));
		await writeFile(path.join(dir, "a.txt"), "a\n");
		await writeFile(path.join(env.outside, "b.txt"), "b\n");
		const svc = service(env);
		await readWorkspaceFile(env.workspace, { path: path.join(dir, "a.txt") }, { permissionService: svc, toolCallId: "r1", promptContext: prompt("allow-session-subtree") });
		await expect(readWorkspaceFile(env.workspace, { path: path.join(dir, "a.txt") }, { permissionService: svc, toolCallId: "r2", promptContext: noUi() })).resolves.toMatchObject({ content: "a\n" });
		await expect(readWorkspaceFile(env.workspace, { path: path.join(env.outside, "b.txt") }, { permissionService: svc, toolCallId: "r3", promptContext: noUi() })).resolves.toMatchObject({ status: "failed" });
	});

	it("read grant 不覆盖同一路径的写操作", async () => {
		const file = path.join(env.outside, "a.txt");
		await writeFile(file, "a\n");
		const svc = service(env);
		const read = await readWorkspaceFile(env.workspace, { path: file }, { permissionService: svc, toolCallId: "r1", promptContext: prompt("allow-session-subtree") });
		if (!("version" in read)) throw new Error("read failed");
		await expect(editWorkspace(env.workspace, { operations: [{ type: "replace_file", path: file, base_version: read.version, content: "b\n" }] }, { permission: { permissionService: svc, toolCallId: "e1", promptContext: noUi() } })).resolves.toMatchObject({ status: "failed", error: { code: "PERMISSION_PROMPT_UNAVAILABLE" } });
	});

	it("always allow 对相同 bash 命令持久生效", async () => {
		const svc = service(env);
		await expect(svc.authorizeSubjectCall({ kind: "tool", configKey: "bash", input: { command: "git status" }, executionId: "b1", promptContext: prompt("always-allow") })).resolves.toMatchObject({ allowed: true });
		expect((await svc.listPersistentGrants()).map((grant) => grant.scopes.map((scope) => scope.kind))).toEqual([["command-exact"]]);
		const next = service(env);
		await expect(next.authorizeSubjectCall({ kind: "tool", configKey: "bash", input: { command: "git status" }, executionId: "b2", promptContext: noUi() })).resolves.toMatchObject({ allowed: true });
		await expect(next.authorizeSubjectCall({ kind: "tool", configKey: "bash", input: { command: "git diff" }, executionId: "b3", promptContext: noUi() })).resolves.toMatchObject({ allowed: false });
	});

	it("工具源文件内容变化后 persistent grant 失效", async () => {
		const packageDir = path.join(env.workspace, "identity-tool");
		const extensionPath = path.join(packageDir, "index.ts");
		const dataPath = path.join(env.outside, "a.txt");
		await mkdir(packageDir);
		await writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "identity-tool", version: "1.0.0", pi: { identity: "manifest-a" } }));
		await writeFile(extensionPath, "export default function extension() {}\n");
		await writeFile(dataPath, "a\n");

		const svc = service(env);
		await svc.syncRegisteredTools([readToolInfo(extensionPath, packageDir)]);
		await expect(svc.authorizeSubjectCall({ kind: "tool", configKey: "read", input: { path: dataPath }, executionId: "r1", promptContext: prompt("always-allow") })).resolves.toMatchObject({ allowed: true });
		expect(await svc.listPersistentGrants()).toHaveLength(1);

		await writeFile(extensionPath, "export default function extension() { return 1; }\n");
		await svc.syncRegisteredTools([readToolInfo(extensionPath, packageDir)]);
		await expect(svc.authorizeSubjectCall({ kind: "tool", configKey: "read", input: { path: dataPath }, executionId: "r2", promptContext: noUi() })).resolves.toMatchObject({
			allowed: false,
			error: { code: "PERMISSION_PROMPT_UNAVAILABLE" },
		});
	});

	it("没有持久化语义的请求不显示 Always allow", async () => {
		let choices: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				select: async (_title: string, options: string[]) => {
					choices = options;
					return "Deny";
				},
			},
		};
		await promptContextFromUi(ctx as Parameters<typeof promptContextFromUi>[0], 1000).prompt(requestWithResources([{ kind: "opaque", label: "unknown" }]), askDecision());
		expect(choices).not.toContain("Always allow");
		await promptContextFromUi(ctx as Parameters<typeof promptContextFromUi>[0], 1000).prompt(requestWithResources([{ kind: "command", command: "git status" }]), askDecision());
		expect(choices).toContain("Always allow");
		expect(choices).not.toContain("Allow subtree for session");
	});
});

function requestWithResources(resources: AuthorizationRequest["resources"]): AuthorizationRequest {
	return {
		requestId: "req",
		subject: subject(),
		inputFingerprint: "fp",
		operations: [],
		resources,
		summary: "test",
		policyGeneration: 1,
	};
}

function subject(): PermissionSubject {
	return {
		id: "tool:test",
		kind: "tool",
		configKey: "test",
		displayName: "test",
		source: { type: "extension", name: "test", identity: "test" },
	};
}

function readToolInfo(extensionPath: string, baseDir: string): ToolInfo {
	return {
		name: "read",
		description: "Read file",
		parameters: Type.Object({ path: Type.String() }),
		promptGuidelines: [],
		sourceInfo: {
			path: extensionPath,
			source: "local",
			scope: "user",
			origin: "top-level",
			baseDir,
		},
	};
}

function askDecision(): CompiledDecision {
	return { effect: "ask", finalEffect: "ask", source: "profile", trace: [{ source: "profile", effect: "ask", message: "test" }] };
}
