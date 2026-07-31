import { writeFile } from "node:fs/promises";
import os from "node:os";
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
			deny_rules: [{ name: "no-push", tools: ["bash"], command_regex: "^git\\s+push\\b", reason: "no pushing" }],
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
			deny_rules: [{ name: "no-push", tools: ["bash"], command_regex: "^git\\s+push\\b", reason: "no pushing" }],
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

	it("已证明仅影响 mktemp 临时目录的脚本默认放行", async () => {
		const request = await bashRequest(`
set -eu
root="$PWD"
tmpdir=$(mktemp -d)
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT
cat > "$tmpdir/input.txt" <<'EOF'
content
EOF
for engine in xelatex lualatex; do
	(cd "$tmpdir" && TOOL_INPUT="$root//:" "$engine" input.txt > result.txt)
done
`);
		expect(evaluateApproval(request, defaultApprovalGateConfig(), store())).toEqual({ kind: "allow" });
	});

	it("显式 deny 仍可阻止 temporary 单元", async () => {
		const config = configWith({
			deny_rules: [{ name: "no-rm", tools: ["bash"], command_regex: "^rm\\b", reason: "no removal" }],
		});
		const request = await bashRequest(`tmpdir=$(mktemp -d)\nrm -rf "$tmpdir"`);
		expect(evaluateApproval(request, config, store())).toMatchObject({
			kind: "deny",
			rule_name: "no-rm",
		});
	});

	it("系统临时目录后代中的递归删除默认放行，但目录根本身仍询问", async () => {
		const tempRoot = os.tmpdir();
		expect(evaluateApproval(
			await bashRequest(`rm -rf "${path.join(tempRoot, "pi-approval", "work")}"`),
			defaultApprovalGateConfig(),
			store(),
		)).toEqual({ kind: "allow" });
		expect(evaluateApproval(
			await bashRequest(`rm -rf "${tempRoot}"`),
			defaultApprovalGateConfig(),
			store(),
		)).toMatchObject({ kind: "ask" });
	});

	it.skipIf(process.platform === "win32")("/tmp 后代中的递归删除默认放行", async () => {
		expect(evaluateApproval(
			await bashRequest("rm -rf /tmp/pi-approval-work"),
			defaultApprovalGateConfig(),
			store(),
		)).toEqual({ kind: "allow" });
		expect(evaluateApproval(
			await bashRequest("rm -rf /tmp"),
			defaultApprovalGateConfig(),
			store(),
		)).toMatchObject({ kind: "ask" });
	});

	it.each([
		`tmpdir=/etc\nrm -rf "$tmpdir"`,
		`tmpdir=$(mktemp -d)\nread tmpdir\nrm -rf "$tmpdir"`,
		`tmpdir=$(mktemp -d)\nsudo rm -rf "$tmpdir"`,
	])("临时范围无法静态证明时仍询问: %s", async (command) => {
		expect(evaluateApproval(await bashRequest(command), defaultApprovalGateConfig(), store())).toMatchObject({
			kind: "ask",
		});
	});

	it.each([
		"echo hello",
		`echo "git push origin main"`,
		"gh release view v1.0.0",
		"npm test",
		"rm -r build",
		"git clean -d",
		"docker ps",
		"kubectl get pods",
		"terraform plan",
		`bash -c "echo ready"`,
	])("默认 command_regex 不匹配 %s", async (command) => {
		expect(evaluateApproval(await bashRequest(command), defaultApprovalGateConfig(), store())).toEqual({ kind: "allow" });
	});

	it.each([
		["git push origin main", "external publishing"],
		["git -C repo push origin main", "external publishing"],
		["gh -R owner/repo release create v1.0.0", "external publishing"],
		["twine upload dist/*", "external publishing"],
		["docker --context remote push example/app:latest", "external publishing"],
		["npm publish", "external publishing"],
		["pnpm publish", "external publishing"],
		["yarn publish", "external publishing"],
		["cargo publish", "external publishing"],
		["sudo systemctl restart nginx", "system-level command"],
		["sudo -u root npm install lodash", "system-level command"],
		["systemctl restart nginx", "system-level command"],
		["service nginx restart", "system-level command"],
		["launchctl unload service.plist", "system-level command"],
		["env -u NODE_ENV npm install lodash", "package management"],
		["command pnpm add lodash", "package management"],
		["npm install lodash", "package management"],
		["pip uninstall package", "package management"],
		["uv tool install ruff", "package management"],
		["cargo install ripgrep", "package management"],
		["brew upgrade package", "package management"],
		["apt-get remove package", "package management"],
		["dnf update package", "package management"],
		["yum install package", "package management"],
		["go install example.com/tool@latest", "package management"],
		["pacman -Syu", "package management"],
		["rm -r -f build", "destructive command"],
		["rmdir empty-dir", "destructive command"],
		["git reset --hard HEAD", "destructive command"],
		["git clean -fd", "destructive command"],
		["docker system prune", "destructive command"],
		["kubectl apply -f deploy.yaml", "infrastructure side effect"],
		["kubectl -n production apply -f deploy.yaml", "infrastructure side effect"],
		["terraform destroy -auto-approve", "infrastructure side effect"],
		["docker --context remote rm container-id", "infrastructure side effect"],
		["docker container rm container-id", "infrastructure side effect"],
		["docker prune", "infrastructure side effect"],
		["eval $SCRIPT", "dynamic or unparsable shell input"],
		[`"$COMMAND" arg`, "dynamic or unparsable shell input"],
		[`bash -c "$SCRIPT"`, "dynamic or unparsable shell input"],
		[`echo "unterminated`, "dynamic or unparsable shell input"],
	] as const)("默认 command_regex 匹配 %s", async (command, reason) => {
		expect(evaluateApproval(await bashRequest(command), defaultApprovalGateConfig(), store())).toMatchObject({
			kind: "ask",
			reason,
		});
	});

	it("非法 regex 在配置加载阶段报错", async () => {
		const configPath = path.join(dir, "approval.jsonc");
		process.env.PI_APPROVAL_GATE_CONFIG = configPath;
		await writeFile(configPath, '{ "ask_rules": [{ "name": "bad", "tools": ["bash"], "command_regex": "(", "reason": "bad" }] }');
		await expect(loadApprovalGateConfig()).rejects.toThrow("invalid regular expression");
	});

	it("effects 不再是合法规则字段", async () => {
		const configPath = path.join(dir, "approval.jsonc");
		process.env.PI_APPROVAL_GATE_CONFIG = configPath;
		await writeFile(configPath, '{ "ask_rules": [{ "name": "legacy", "tools": ["bash"], "effects": ["publish"], "reason": "legacy" }] }');
		await expect(loadApprovalGateConfig()).rejects.toThrow("config does not match schema");
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
