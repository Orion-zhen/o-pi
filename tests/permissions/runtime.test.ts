import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PermissionServiceRegistry } from "../../src/pi-runtime/permission-service-registry.js";
import { tempEnv, prompt, noUi, type TempEnv } from "./helpers.js";

let env: TempEnv;
let previousAgentDir: string | undefined;

beforeEach(async () => {
	env = await tempEnv();
	previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = env.agentDir;
});

afterEach(async () => {
	if (previousAgentDir === undefined) {
		delete process.env["PI_CODING_AGENT_DIR"];
	} else {
		process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
	}
	await env.cleanup();
});

describe("permission runtime", () => {
	it("registry clear 会清除 session grants 和 leases", async () => {
		const file = path.join(env.outside, "a.txt");
		await writeFile(file, "a\n");
		const registry = new PermissionServiceRegistry();
		const ctx = { cwd: env.workspace, isProjectTrusted: () => false, sessionManager: { getSessionFile: () => "s1" } };
		const svc = await registry.serviceFor(ctx);
		await svc.authorizeSubjectCall({ kind: "tool", configKey: "read", input: { path: file }, executionId: "r", promptContext: prompt("allow-session-subtree") });
		expect(svc.getSessionGrants().count()).toBe(1);
		registry.clear("test");
		const next = await registry.serviceFor(ctx);
		await expect(next.authorizeSubjectCall({ kind: "tool", configKey: "read", input: { path: file }, executionId: "r2", promptContext: noUi() })).resolves.toMatchObject({ allowed: false });
	});
});
