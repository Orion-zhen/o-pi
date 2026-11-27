import { expect, it, vi } from "vitest";
import { evaluateShellGatePolicy } from "../../../src/harness/approval/rules/policy.ts";
import { SessionApprovalStore } from "../../../src/harness/approval/rules/store.ts";
import type { PathGlob, ShellPolicyConfig } from "../../../src/harness/approval/types.ts";
import { buildBashApprovalRequest } from "../../../src/harness/approval/request/bash/parse.ts";

vi.mock("node:path", async (load) => ({ default: (await load<typeof import("node:path")>()).win32 }));
vi.mock("node:os", async (load) => ({ default: { ...(await load<typeof import("node:os")>()), tmpdir: () => "D:\\Temp" } }));

function bashRequest(command: string, cwd: string) {
	return buildBashApprovalRequest(command, { command, cwd, env: {} }, { askpass: false });
}

it.each([
	["d:/TEMP/log", "d:/TEMP/log", true],
	["D:/Temp", "D:/Temp", false],
	["D:/Temp/../log", "D:/log", false],
	["C:/Temp/log", "C:/Temp/log", false],
	["//server/share/log", "//server/share/log", false],
	["result.log", "D:/work/result.log", false],
] as const)("按 Windows 宿主路径解析重定向: %s", async (input, expected, temporary) => {
	const request = await bashRequest(`echo ok >"${input}"`, "D:\\work");
	const redirect = request.units.find((unit) => unit.action === "write_redirect");
	expect(redirect?.target).toEqual({ kind: "path", value: expected });
	expect(redirect?.effect_scope).toBe(temporary ? "temporary" : undefined);
});

it("Bash 单根绝对路径按 Shell 路径匹配，不推断宿主盘符或临时范围", async () => {
	const r = await bashRequest('out=/reports/./log; printf ok >"$out"', 'D:/Temp/work');
	expect(r.units.find(u => u.action === "write_redirect")).toMatchObject({
		target: { kind: "path", value: "/reports/log" }, remember: false,
	});
	const decide = (...path_globs: PathGlob[]) => evaluateShellGatePolicy(r, { default_action: "allow", combinations: {}, facts: {
		protected: { action: "deny", reason: "protected", path_globs, commands: [] },
	} }, new SessionApprovalStore()).decision;
	expect(decide({ pattern: "/other/**" }).kind).toBe("allow");
	for (const host of [{ pattern: "D:/reports/**" }, { pattern: "//server/share/**" }, { pattern: "**/System32/**" }, { directory: "D:/reports", pattern: "/**" }]) {
		expect(decide(host)).toMatchObject({ kind: "ask", items: [{ unit: { target: { value: "/reports/log" } } }] });
		expect(decide(host, { pattern: "/reports/**" })).toMatchObject({ kind: "deny", rule_name: "protected" });
	}
});

it("仅当宿主路径事实可能改变组合决策时才询问", async () => {
	const policy: ShellPolicyConfig = { default_action: "allow", facts: {
		host: { path_globs: [{ pattern: "C:/reports/**" }], commands: [] },
		push: { commands: [{ classifier: "push", command: ["git", "push"] }] },
	}, combinations: { both: { action: "deny", reason: "both", all: ["host", "push"] } } };
	for (const [script, kind] of [['echo ok >/reports/log', 'allow'], ['git push >/reports/log', 'ask'], ['git push >C:/reports/log', 'deny']] as const) {
		const r = await bashRequest(script, 'D:/work');
		expect(evaluateShellGatePolicy(r, policy, new SessionApprovalStore()).decision.kind).toBe(kind);
	}
});

it.each(['>/reports/*.log', '>"/reports/$(date)"', '>D:log', '>//?/D:/Temp/log'])('目标不确定时仍按动态重定向检查：%s', async (redirect) => {
	const r = await bashRequest(`echo ok ${redirect}`, 'D:/work');
	expect(r.units.find(u => u.action === "write_redirect")).toMatchObject({ analysisFact: "shell.run-opaque-input", remember: false });
});

it("PID 文件名保留 Windows 临时目录约束，不推测 POSIX 挂载点", async () => {
	const request = await bashRequest('echo ok >D:/Temp/log-$$.txt; echo ok >/Temp/log-$$.txt', 'D:/work');
	expect(request.units.filter((unit) => unit.action === "write_redirect")).toMatchObject([
		{ target: { directory: "D:/Temp", numericName: { prefix: "log-", suffix: ".txt" } }, effect_scope: "temporary" },
		{ analysisFact: "shell.run-opaque-input", target: { kind: "command", value: ">/Temp/log-$$.txt" } },
	]);
});

it.each(["/Temp/log", "/d/Temp/log", "D:log", "//?/D:/Temp/log"])("不猜测 Bash 到 Windows 的路径映射: %s", async (input) => {
	const request = await bashRequest(`cd "${input}" && printf ok >result.log`, "D:\\Temp\\work");
	expect(request.units.at(-1)).toMatchObject({ action: "write_redirect", analysisFact: "shell.run-opaque-input", target: { value: ">result.log" } });
});
