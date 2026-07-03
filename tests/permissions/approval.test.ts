import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tempEnv, service, noUi, type TempEnv } from "./helpers.js";
import { renderPermissionApprovalPrompt } from "../../src/permissions/approval-prompt.js";
import type { AuthorizationRequest, CompiledDecision, ResolvedFileResource } from "../../src/permissions/permission-types.js";

let env: TempEnv;

beforeEach(async () => {
	env = await tempEnv();
});

afterEach(async () => {
	await env.cleanup();
});

describe("approval", () => {
	it("无 UI ask 转 deny", async () => {
		const file = path.join(env.outside, "a.txt");
		await writeFile(file, "a\n");
		const result = await service(env).authorizeSubjectCall({ kind: "tool", configKey: "read", input: { path: file }, executionId: "r", promptContext: noUi() });
		expect(result).toMatchObject({ allowed: false, error: { code: "PERMISSION_PROMPT_UNAVAILABLE" } });
	});

	it("未注册的非 tool 主体 fail closed", async () => {
		const result = await service(env).authorizeSubjectCall({ kind: "mcp-tool", configKey: "demo/run", input: {}, executionId: "m1", promptContext: noUi() });
		expect(result).toMatchObject({ allowed: false, error: { code: "PERMISSION_UNKNOWN_SUBJECT" } });
	});

	it("相同并发 deny 请求合并一次 prompt", async () => {
		const file = path.join(env.outside, "a.txt");
		await writeFile(file, "a\n");
		const calls: string[] = [];
		const ctx = {
			hasUI: true,
			timeoutMs: 120000,
			prompt: async () => {
				calls.push("prompt");
				await new Promise((resolve) => setTimeout(resolve, 20));
				return { decision: "deny" as const };
			},
		};
		const svc = service(env);
		const results = await Promise.all([
			svc.authorizeSubjectCall({ kind: "tool", configKey: "read", input: { path: file }, executionId: "r1", promptContext: ctx }),
			svc.authorizeSubjectCall({ kind: "tool", configKey: "read", input: { path: file }, executionId: "r2", promptContext: ctx }),
		]);
		expect(calls).toHaveLength(1);
		expect(results).toEqual([expect.objectContaining({ allowed: false }), expect.objectContaining({ allowed: false })]);
	});

	it("相同并发 allow-once 请求只放行一个并重新审批其余请求", async () => {
		const file = path.join(env.outside, "a.txt");
		await writeFile(file, "a\n");
		const decisions = ["allow-once", "deny"] as const;
		const calls: string[] = [];
		const ctx = {
			hasUI: true,
			timeoutMs: 120000,
			prompt: async () => {
				calls.push("prompt");
				await new Promise((resolve) => setTimeout(resolve, 20));
				return { decision: decisions[calls.length - 1] ?? "deny" };
			},
		};
		const svc = service(env);
		const results = await Promise.all([
			svc.authorizeSubjectCall({ kind: "tool", configKey: "read", input: { path: file }, executionId: "r1", promptContext: ctx }),
			svc.authorizeSubjectCall({ kind: "tool", configKey: "read", input: { path: file }, executionId: "r2", promptContext: ctx }),
		]);
		expect(calls).toHaveLength(2);
		expect(results.filter((result) => result.allowed)).toHaveLength(1);
		expect(results.filter((result) => !result.allowed)).toHaveLength(1);
	});

	it("审批正文展示主体、资源、策略 trace 和 grant 影响", async () => {
		const file = path.join(env.outside, "a.txt");
		await writeFile(file, "a\n");
		let promptText = "";
		const svc = service(env);
		await svc.authorizeSubjectCall({
			kind: "tool",
			configKey: "read",
			input: { path: file },
			executionId: "r",
			promptContext: {
				hasUI: true,
				timeoutMs: 120000,
				prompt: async (request, decision) => {
					promptText = renderPermissionApprovalPrompt(request, decision);
					return { decision: "deny" };
				},
			},
		});
		expect(promptText).toContain("Tool: read");
		expect(promptText).toContain("Source: extension o-pi");
		expect(promptText).toContain("Identity: extension:o-pi:file-tools");
		expect(promptText).toContain(`read ${file}`);
		expect(promptText).toContain(`canonical: ${file}`);
		expect(promptText).toContain("files.outsideRoots.read ask");
		expect(promptText).toContain("Policy trace:");
		expect(promptText).toContain("Always allow: persistent grant");
	});

	it("审批正文展示符号链接链和 subtree 实际目录", () => {
		const lexical = path.join(env.workspace, "link", "a.ts");
		const canonical = path.join(env.outside, "a.ts");
		const file: ResolvedFileResource = {
			kind: "file",
			inputPath: "link/a.ts",
			lexicalAbsolutePath: lexical,
			canonicalPath: canonical,
			lexicalType: "symlink",
			targetType: "file",
			exists: true,
			viaSymlink: true,
			symlinkChain: [lexical, canonical],
			identity: { device: 1, inode: 2 },
			displayPath: canonical,
			access: "write",
			operation: "file.update",
		};
		const request: AuthorizationRequest = {
			requestId: "perm_test",
			toolCallId: "edit-1",
			subject: {
				id: "tool:edit",
				kind: "tool",
				configKey: "edit",
				displayName: "edit",
				source: { type: "extension", name: "o-pi", identity: "sha256:test" },
			},
			inputFingerprint: "fingerprint",
			operations: ["file.update"],
			resources: [file],
			summary: "Edit files",
			policyGeneration: 1,
		};
		const decision: CompiledDecision = {
			effect: "ask",
			finalEffect: "ask",
			source: "global-policy",
			trace: [{ source: "global-policy", effect: "ask", message: "files.outsideRoots.write ask" }],
		};
		const text = renderPermissionApprovalPrompt(request, decision);
		expect(text).toContain("Tool: edit");
		expect(text).toContain(`update ${canonical} (write)`);
		expect(text).toContain(`lexical: ${lexical}`);
		expect(text).toContain(`- ${path.dirname(canonical)} (write, update)`);
		expect(text).toContain(`${lexical} -> ${canonical}`);
	});
});
