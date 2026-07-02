import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { parsePermissionCommand } from "../../../src/permissions/commands/command-parser.js";
import { routePermissionCommand } from "../../../src/permissions/commands/command-router.js";
import { JsonPermissionRenderer } from "../../../src/permissions/commands/output-renderer.js";
import type { PermissionCommandContext } from "../../../src/permissions/commands/permission-command.js";
import { service, tempEnv, type TempEnv } from "../helpers.js";

let env: TempEnv;

beforeEach(async () => {
	env = await tempEnv();
});

afterEach(async () => {
	await env.cleanup();
});

describe("permissions command router", () => {
	it("status --json 输出可 JSON.parse", async () => {
		const runtime = service(env);
		const parsed = parsePermissionCommand("status --json");
		const result = await routePermissionCommand(parsed, context(runtime, "json"));
		const json = JSON.parse(new JsonPermissionRenderer().render(result)) as { ok: boolean; command: string };
		expect(json).toMatchObject({ ok: true, command: "status" });
	});

	it("catalog 基于实际注册表展示工具", async () => {
		const runtime = service(env);
		const result = await routePermissionCommand(parsePermissionCommand("catalog tools"), context(runtime));
		expect(result.human).toContain("read");
		expect(result.human).toContain("bash");
	});

	it("explain bash 使用命令规则 trace", async () => {
		const runtime = service(env);
		const result = await routePermissionCommand(parsePermissionCommand("explain bash \"git status\""), context(runtime));
		expect(result.human).toContain("Permission explanation");
		expect(result.human).toContain("git status");
	});

	it("set/reset 保留 JSONC 注释并 reload generation", async () => {
		const runtime = service(env);
		const policyPath = path.join(env.agentDir, "permissions.jsonc");
		await mkdir(path.dirname(policyPath), { recursive: true });
		await writeFile(policyPath, "{\n\t// keep\n\t\"version\": 1,\n\t\"tools\": { \"items\": { \"read\": \"allow\" } }\n}\n", "utf8");
		await routePermissionCommand(parsePermissionCommand("set read ask --global"), context(runtime));
		await routePermissionCommand(parsePermissionCommand("reset read --global"), context(runtime));
		const text = await readFile(policyPath, "utf8");
		expect(text).toContain("// keep");
		expect(text).not.toContain("\"read\"");
	});

	it("roots add --session 参与后续 explain", async () => {
		const runtime = service(env);
		const file = path.join(env.outside, "a.txt");
		await writeFile(file, "a\n");
		await routePermissionCommand(parsePermissionCommand(`roots add "${env.outside}" read-only --session`), context(runtime));
		const result = await routePermissionCommand(parsePermissionCommand(`explain read "${file}"`), context(runtime));
		expect(result.human).toContain("ALLOW");
	});
});

function context(runtime: ReturnType<typeof service>, outputMode: "human" | "json" = "human"): PermissionCommandContext {
	const ctx = {
		cwd: env.workspace,
		hasUI: false,
		signal: undefined,
		isProjectTrusted: () => false,
		sessionManager: { getSessionFile: () => "test-session" },
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			editor: async () => undefined,
			notify() {},
			setStatus() {},
		},
	} as unknown as ExtensionCommandContext;
	return {
		runtime,
		ctx,
		interactive: false,
		outputMode,
		workspacePath: env.workspace,
		agentDir: env.agentDir,
	};
}
