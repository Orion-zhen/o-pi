import "./fixture.ts";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach } from "vitest";
import { loadApprovalGateConfig } from "../../../src/harness/approval/config.ts";
import { buildBashApprovalRequest } from "../../../src/harness/approval/request/bash/parse.ts";
import { resolvePathGlobs } from "../../../src/harness/approval/rules/path-match.ts";
import { evaluateGatePolicy } from "../../../src/harness/approval/rules/policy.ts";
import { SessionApprovalStore } from "../../../src/harness/approval/rules/store.ts";
import type { ApprovalGateConfig, ApprovalRequest } from "../../../src/harness/approval/types.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

export const commandCwd = path.join(path.parse(process.cwd()).root, "workspace", "project").replaceAll("\\", "/");

export function bashRequest(command: string, env: NodeJS.ProcessEnv = {}, cwd = commandCwd) {
	return buildBashApprovalRequest(command, { command, cwd, env }, { askpass: false });
}

export function usePolicyFixture() {
	const temp = useTempDir("o-pi-approval-policy-");
	const configPath = () => path.join(temp.path, "approval.jsonc");
	let config: ApprovalGateConfig;
	preserveEnv("PI_APPROVAL_GATE_CONFIG");
	beforeEach(async () => {
		process.env.PI_APPROVAL_GATE_CONFIG = configPath();
		config = await loadApprovalGateConfig();
	});
	return {
		get config() { return config; },
		async loadOverrides(tools: Record<string, unknown>) {
			await writeFile(configPath(), JSON.stringify({ tools }));
			return loadApprovalGateConfig();
		},
		decide(request: ApprovalRequest, policy = config) {
			return evaluateGatePolicy(request, policy, new SessionApprovalStore());
		},
		withPathFact(glob: string, action: "ask" | "deny" = "deny") {
			const policy = structuredClone(config);
			policy.tools.shell.facts.protected = { path_globs: resolvePathGlobs([glob], "path"), commands: [], action, reason: "protected" };
			return policy;
		},
	};
}
