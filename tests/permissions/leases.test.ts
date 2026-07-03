import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readWorkspaceFile } from "../../src/file-tools/read-tool.js";
import { tempEnv, service, prompt, type TempEnv } from "./helpers.js";

let env: TempEnv;

beforeEach(async () => {
	env = await tempEnv();
});

afterEach(async () => {
	await env.cleanup();
});

describe("leases", () => {
	it("tool_call 创建 lease，execute 消费后不能再次使用", async () => {
		const file = path.join(env.outside, "a.txt");
		await writeFile(file, "a\n");
		const svc = service(env);
		const gate = await svc.authorizeSubjectCall({ kind: "tool", configKey: "read", input: { path: file }, executionId: "r", promptContext: prompt("allow-once") });
		expect(gate.allowed).toBe(true);
		await expect(readWorkspaceFile(env.workspace, { path: file }, { permissionService: svc, toolCallId: "r", promptContext: prompt("deny") })).resolves.toMatchObject({ content: "a\n" });
		await expect(readWorkspaceFile(env.workspace, { path: file }, { permissionService: svc, toolCallId: "r", promptContext: prompt("deny") })).resolves.toMatchObject({ status: "failed" });
	});
});
