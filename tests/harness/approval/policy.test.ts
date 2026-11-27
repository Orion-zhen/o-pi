import { bashRequest, commandCwd, usePolicyFixture } from "./policy-fixture.ts";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { buildWebFetchApprovalRequest } from "../../../src/harness/approval/pi/request.ts";
import { evaluateShellGatePolicy } from "../../../src/harness/approval/rules/policy.ts";
import { SessionApprovalStore } from "../../../src/harness/approval/rules/store.ts";

const fixture = usePolicyFixture();
const { decide, loadOverrides } = fixture;

it("默认拒绝和显式拒绝都优先于临时目录豁免", async () => {
	const request = await bashRequest(`rm -rf "${path.join(os.tmpdir(), "build")}"`);
	fixture.config.tools.shell.default_action = "deny";
	expect(decide(request)).toMatchObject({ kind: "deny", rule_name: "default-bash-policy" });
	const config = await loadOverrides({ shell: { facts: {
		"custom.no-rm": { action: "deny", reason: "Deletion disabled.", commands: { remove: { command: ["rm"] } } },
	} } });
	const publish = await bashRequest('tmp=$(mktemp -d); git push; rm -rf "$tmp"');
	expect(decide(publish, config)).toMatchObject({ kind: "deny", rule_name: "custom.no-rm" });
});

it("多个事实和组合对同一单元只产生一次审批", async () => {
	const shell = fixture.config.tools.shell;
	const reason = "用户规则; 保留完整原因";
	shell.facts["custom.push"] = { action: "ask", reason, commands: [{ classifier: "push", command: ["git", "push"] }] };
	shell.default_action = "ask";
	shell.combinations.review = { all: ["custom.push", "release"], action: "ask", reason: "Review the destination." };
	expect(decide(await bashRequest("git push origin main"))).toMatchObject({
		kind: "ask", items: [{ reason: `确认发布目标; ${reason}; Review the destination.` }],
	});
});

it.each(["echo hello", "x=1"])("Bash 默认动作要求审批：%s", async command => {
	fixture.config.tools.shell.default_action = "ask";
	expect(decide(await bashRequest(command))).toMatchObject({ kind: "ask", reason: "This tool requires approval by default." });
});

it("单个目标命中多个询问事实时合并原因，不再使用默认拒绝", () => {
	const origin = "http://10.0.0.1";
	const request = buildWebFetchApprovalRequest(commandCwd, { scope: "private", origin, url: origin, addresses: ["10.0.0.1"] });
	const policy = fixture.config.tools.webfetch;
	policy.default_action = "deny";
	policy.facts.audit = { match_all: true, action: "ask", reason: "audit" };
	policy.facts.internal = { network_scope: "private", action: "ask", reason: "audit" };
	const reason = "确认内网地址; audit";
	expect(decide(request)).toEqual({ kind: "ask", reason, items: [{ unit: request.unit, reason }] });
});

it("自定义拒绝规则匹配 env 包装的安装命令", async () => {
	fixture.config.tools.shell.facts["custom.package-deny"] = { action: "deny", reason: "Package installation is disabled.",
		commands: [{ classifier: "npm", command: ["npm", "install"] }],
	};
	expect(decide(await bashRequest("env NODE_ENV=test npm --prefix app install lodash"))).toMatchObject({ kind: "deny", rule_name: "custom.package-deny" });
	expect(decide(await bashRequest("npm --prefix app run install"))).toEqual({ kind: "allow" });
});

it.each(["linux", "darwin", "win32"] as const)("平台限定分类器只在目标平台产生事实: %s", async platform => {
	const config = await loadOverrides({ shell: { facts: {
		"custom.platform": { action: "deny", reason: "Tool disabled on this platform.", commands: { only: { platform, command: ["example-tool"] } } },
	} } });
	expect(decide(await bashRequest("example-tool"), config).kind).toBe(platform === process.platform ? "deny" : "allow");
});

it.runIf(process.platform === "win32")("Windows 服务审批不区分命令和操作名大小写", async () => {
	const config = await loadOverrides({ shell: { facts: {
		service: { action: "ask", reason: "确认服务操作", commands: { custom: { platform: "win32", command: ["{sc,sc.exe}", "{start,stop}"] } } },
	} } });
	for (const command of ["SC.EXE StArT Example", "SC STOP Example"]) expect(decide(await bashRequest(command), config).kind).toBe("ask");
});

it("路径事实和参数事实独立命中，可在同一次 Bash 调用中组合", async () => {
	const config = await loadOverrides({ shell: {
		facts: {
			output: { path_globs: [`${commandCwd}/report`] },
			argument: { commands: { report: { command: ["printf"], arg_globs: ["report"] } } },
		},
		combinations: { both: { all: ["output", "argument"], action: "deny", reason: "Report output is restricted." } },
	} });
	for (const [command, facts, decision] of [
		["printf report", ["argument"], { kind: "allow" }],
		["printf ok >report", ["output"], { kind: "allow" }],
		["printf report >report", ["output", "argument"], { kind: "deny", rule_name: "both" }],
	] as const) {
		const result = evaluateShellGatePolicy(await bashRequest(command), config.tools.shell, new SessionApprovalStore());
		expect(result.facts.facts).toEqual(facts);
		expect(result.decision).toMatchObject(decision);
	}
});

it("发布规则禁用 Git、改用 Podman 后只询问 Podman 推送，并继承发布原因", async () => {
	const config = await loadOverrides({ shell: { facts: {
		release: { commands: { git: false, image: { command: ["podman", "push"] } } },
	} } });
	const request = await bashRequest("git push origin main && docker push example/app:latest && podman push example/app:latest");
	expect(decide(request, config)).toMatchObject({ kind: "ask", items: [{ unit: { target: { value: "podman push example/app:latest" } }, reason: "确认发布目标" }] });
});

it("清理工作区时预演无需审批，实际删除需要审批", async () => {
	expect(decide(await bashRequest("git -C repo clean -dfn"))).toEqual({ kind: "allow" });
	expect(decide(await bashRequest("git -C repo clean -fd"))).toMatchObject({ kind: "ask", reason: "确认清理范围" });
});

it("容器查询例外不放行另一分支上的删除操作", async () => {
	fixture.config.tools.shell.facts.containers = { action: "ask", reason: "确认容器操作", commands: [
		{ classifier: "docker", command: ["docker"], except: [["docker", "inspect"]] },
	] };
	const request = await bashRequest('if test -f .dry-run; then op=inspect; else op=rm; fi; docker "$op" app');
	expect(decide(request)).toMatchObject({ kind: "ask", items: [{ unit: { target: { value: 'docker "$op" app' } } }] });
});

it.each([
	["git -C status log", "ask"], ['read dir; git -C "$dir" status', "allow"], ['read dir; git -C $dir status', "ask"],
] as const)("只在能确定 Git 子命令是 status 时豁免：%s", async (command, kind) => {
	fixture.config.tools.shell.facts.review = { action: "ask", reason: "Review repository access.",
		commands: [{ classifier: "git", command: ["git"], except: [["git", "status"]] }],
	};
	expect(decide(await bashRequest(command)).kind).toBe(kind);
});

it("从 JSONC 加载命令和管道规则，按参数边界及管道阶段匹配", async () => {
	const config = await loadOverrides({ shell: { facts: { release: {
		action: "deny", reason: "Release operations are disabled.", commands: {
			tag: { command: ["git", "tag", "stable"], exact: true },
			artifact: { command: ["cp"], arg_globs: ["dist/**"] },
			stream: { pipeline: [{ command: ["git", "archive"], arg_globs: ["HEAD"] }, ["gzip"]] },
		},
	} } } });
	for (const [command, kind] of [
		["git tag stable", "deny"], ["git tag stable HEAD", "allow"],
		['cp "dist/release notes" backup/', "deny"], ["cp README.md backup/", "allow"],
		["git archive HEAD | tee release.tar | gzip >release.tgz", "deny"], ["git archive v1 | gzip", "allow"],
		["git archive -o release.tar HEAD; gzip release.tar", "allow"],
	] as const) {
		expect(decide(await bashRequest(command), config).kind, command).toBe(kind);
	}
});

it.each([
	{ command: [] }, { pipeline: [["git", "archive"]] }, { command: ["git"], shell: "cmd" },
	{ command: ["docker"], except: ["inspect"] }, { command: ["cp"], exact: true, arg_globs: ["dist/**"] },
])("拒绝无效分类器 %j", async rule => {
	await expect(loadOverrides({ shell: { facts: { custom: { commands: { rule } } } } })).rejects.toThrow("does not match schema");
});

it.each([
	{ write: { facts: { locked: { action: "deny", match_all: true } } } },
	{ shell: { facts: { release: { reason: "  " } } } },
	{ shell: { combinations: { both: { all: ["cleanup", "release"], action: "ask" } } } },
])("拒绝合并后缺少非空白原因的动作规则：%j", async tools => {
	await expect(loadOverrides(tools)).rejects.toThrow("merged config");
});

it("拒绝引用不存在的事实的组合", async () => {
	await expect(loadOverrides({ shell: { combinations: {
		publish: { all: ["release", "missing"], action: "deny", reason: "禁止发布" },
	} } })).rejects.toThrow("unknown fact");
});
