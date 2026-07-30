import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { defaultApprovalGateConfig, loadApprovalGateConfig } from "../../src/approval/config.js";
import { evaluateApproval } from "../../src/approval/policy.js";
import { buildApprovalRequest } from "../../src/approval/request-builder.js";
import { FileApprovalStore } from "../../src/approval/store.js";
import type { ApprovalGateConfig, ApprovalRequest } from "../../src/approval/types.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let dir: string;
const temp = useTempDir("o-pi-approval-policy-");
preserveEnv("PI_APPROVAL_GATE_CONFIG");

beforeEach(() => {
	dir = temp.path;
	delete process.env.PI_APPROVAL_GATE_CONFIG;
});

describe("approval policy", () => {
	it("enabled=false 时 allow", async () => {
		const config = configWith({ enabled: false });
		expect(evaluateApproval(await bashRequest("git push origin main"), config, store())).toEqual({ kind: "allow" });
	});

	it("ask_rules 只返回命中的敏感 unit", async () => {
		const request = await bashRequest("echo ready && git push origin main && npm install lodash");
		const decision = evaluateApproval(request, defaultApprovalGateConfig(), store());
		expect(decision).toMatchObject({
			kind: "ask",
			items: [
				{ unit: { target: { value: "git push origin main" } }, reason: "external publishing" },
				{ unit: { target: { value: "npm install lodash" } }, reason: "package management" },
			],
		});
	});

	it("deny_rules 命中时 deny", async () => {
		const config = configWith({
			deny_rules: [{ name: "no-push", tools: ["bash"], effects: ["publish"], reason: "no pushing" }],
		});
		expect(evaluateApproval(await bashRequest("git push origin main"), config, store())).toEqual({
			kind: "deny",
			reason: "no pushing",
			rule_name: "no-push",
		});
	});

	it("custom command_regex 仍匹配单元的语法 wrapper", async () => {
		const config = configWith({
			deny_rules: [{ name: "no-env", tools: ["bash"], command_regex: "^env\\b", reason: "no env wrapper" }],
		});
		expect(evaluateApproval(await bashRequest("env NODE_ENV=test npm install lodash"), config, store())).toMatchObject({
			kind: "deny",
			rule_name: "no-env",
		});
	});

	it("显式 deny 优先于 remembered allow", async () => {
		const request = await bashRequest("git push origin main");
		const approvalStore = store();
		approvalStore.addSessionAllowRules([{
			created_at: "t",
			tool: "bash",
			kind: "exact_command",
			value: "git push origin main",
			cwd: request.cwd,
		}]);
		const config = configWith({
			deny_rules: [{ name: "no-push", tools: ["bash"], effects: ["publish"], reason: "no pushing" }],
		});
		expect(evaluateApproval(request, config, approvalStore)).toMatchObject({ kind: "deny", rule_name: "no-push" });
	});

	it("session allow 只覆盖对应 unit", async () => {
		const request = await bashRequest("git push origin main && npm install lodash");
		const approvalStore = store();
		approvalStore.addSessionAllowRules([{
			created_at: "t",
			tool: "bash",
			kind: "exact_command",
			value: "git push origin main",
			cwd: request.cwd,
		}]);
		expect(evaluateApproval(request, defaultApprovalGateConfig(), approvalStore)).toMatchObject({
			kind: "ask",
			items: [{ unit: { target: { value: "npm install lodash" } } }],
		});
	});

	it("persistent allow rule 命中时 allow", async () => {
		const request = await bashRequest("git push origin main");
		const storePath = path.join(dir, "rules.jsonc");
		const approvalStore = new FileApprovalStore(storePath);
		await approvalStore.addPersistentAllowRules([{
			created_at: "t",
			tool: "bash",
			kind: "exact_command",
			value: "git push origin main",
			cwd: request.cwd,
		}]);
		const reloaded = new FileApprovalStore(storePath);
		await reloaded.loadPersistentRules();
		expect(evaluateApproval(request, defaultApprovalGateConfig(), reloaded)).toEqual({ kind: "allow" });
	});

	it("默认未命中时 allow", async () => {
		expect(evaluateApproval(await bashRequest("echo hello"), defaultApprovalGateConfig(), store())).toEqual({ kind: "allow" });
		expect(evaluateApproval(await bashRequest(`echo "git push origin main"`), defaultApprovalGateConfig(), store())).toEqual({ kind: "allow" });
	});

	it("非法 regex 在配置加载阶段报错", async () => {
		const configPath = path.join(dir, "approval.jsonc");
		process.env.PI_APPROVAL_GATE_CONFIG = configPath;
		await writeFile(configPath, '{ "ask_rules": [{ "name": "bad", "tools": ["bash"], "command_regex": "(", "reason": "bad" }] }');
		await expect(loadApprovalGateConfig()).rejects.toThrow("invalid regular expression");
	});
});

function store(): FileApprovalStore {
	return new FileApprovalStore(path.join(dir, "unused.jsonc"));
}

function configWith(patch: Partial<ApprovalGateConfig>): ApprovalGateConfig {
	return { ...defaultApprovalGateConfig(), ...patch };
}

async function bashRequest(command: string): Promise<ApprovalRequest> {
	const built = await buildApprovalRequest(
		{ type: "tool_call", toolName: "bash", toolCallId: "1", input: { command } },
		dir,
	);
	if (built === undefined) throw new Error("approval request was not built");
	return built;
}
