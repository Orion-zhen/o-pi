import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultApprovalGateConfig, loadApprovalGateConfig } from "../../src/approval/config.js";
import { evaluateApproval } from "../../src/approval/policy.js";
import { FileApprovalStore } from "../../src/approval/store.js";
import type { ApprovalGateConfig, ApprovalRequest } from "../../src/approval/types.js";

let dir: string;
const previousConfig = process.env.PI_APPROVAL_GATE_CONFIG;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "o-pi-approval-policy-"));
	delete process.env.PI_APPROVAL_GATE_CONFIG;
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	if (previousConfig === undefined) delete process.env.PI_APPROVAL_GATE_CONFIG;
	else process.env.PI_APPROVAL_GATE_CONFIG = previousConfig;
});

describe("approval policy", () => {
	it("enabled=false 时 allow", () => {
		const config = configWith({ enabled: false });
		expect(evaluateApproval(bashRequest("git push origin main"), config, store())).toEqual({ kind: "allow" });
	});

	it("ask_rules 命中时 ask", () => {
		const decision = evaluateApproval(bashRequest("git push origin main"), defaultApprovalGateConfig(), store());
		expect(decision).toMatchObject({ kind: "ask", reason: "external publishing", rule_name: "external-publish" });
	});

	it("deny_rules 命中时 deny", () => {
		const config = configWith({
			deny_rules: [{ name: "no-push", tools: ["bash"], command_regex: "\\bgit\\s+push\\b", reason: "no pushing" }],
		});
		expect(evaluateApproval(bashRequest("git push origin main"), config, store())).toEqual({
			kind: "deny",
			reason: "no pushing",
			rule_name: "no-push",
		});
	});

	it("session allow rule 命中时 allow", () => {
		const approvalStore = store();
		approvalStore.addSessionAllowRule({ created_at: "t", tool: "bash", kind: "exact_command", value: "git push origin main" });
		expect(evaluateApproval(bashRequest("git push origin main"), defaultApprovalGateConfig(), approvalStore)).toEqual({ kind: "allow" });
	});

	it("persistent allow rule 命中时 allow", async () => {
		const storePath = path.join(dir, "rules.jsonc");
		const approvalStore = new FileApprovalStore(storePath);
		await approvalStore.addPersistentAllowRule({ created_at: "t", tool: "bash", kind: "exact_command", value: "git push origin main" });
		const reloaded = new FileApprovalStore(storePath);
		await reloaded.loadPersistentRules();
		expect(evaluateApproval(bashRequest("git push origin main"), defaultApprovalGateConfig(), reloaded)).toEqual({ kind: "allow" });
	});

	it("默认未命中时 allow", () => {
		expect(evaluateApproval(bashRequest("echo hello"), defaultApprovalGateConfig(), store())).toEqual({ kind: "allow" });
	});

	it("非法 regex 在配置加载阶段报错", async () => {
		const configPath = path.join(dir, "approval.jsonc");
		process.env.PI_APPROVAL_GATE_CONFIG = configPath;
		await writeFile(configPath, '{ "version": 1, "ask_rules": [{ "name": "bad", "tools": ["bash"], "command_regex": "(", "reason": "bad" }] }');
		await expect(loadApprovalGateConfig()).rejects.toThrow("invalid regular expression");
	});
});

function store(): FileApprovalStore {
	return new FileApprovalStore(path.join(dir, "unused.jsonc"));
}

function configWith(patch: Partial<ApprovalGateConfig>): ApprovalGateConfig {
	return { ...defaultApprovalGateConfig(), ...patch };
}

function bashRequest(command: string): ApprovalRequest {
	return {
		id: "1",
		tool: "bash",
		action: "execute",
		summary: command,
		subject: "command",
		targets: [{ kind: "command", value: command }],
		effects: ["execute"],
		raw_input: { command },
	};
}
