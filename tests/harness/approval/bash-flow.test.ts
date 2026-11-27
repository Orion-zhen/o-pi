import { expect, it } from "vitest";
import { bashRequest, commandCwd, usePolicyFixture } from "./policy-fixture.ts";

const fixture = usePolicyFixture();
const { decide, withPathFact } = fixture;

it("后续候选超限时，先前已确定的写入目标仍能触发拒绝", async () => {
	const branches = ["a", "b", "c", "d"].map((name) => `if test -f flag; then ${name}=x; else ${name}=y; fi`);
	const request = await bashRequest(['echo >report', ...branches, 'echo "$a$b$c$d"'].join("; "));
	expect(decide(request)).toMatchObject({ kind: "ask", reason: "确认动态命令" });
	expect(decide(request, withPathFact(`${request.cwd}/report`))).toMatchObject({ kind: "deny", rule_name: "protected" });
});

it.skipIf(process.platform === "win32")("cd 失败后退出时，不可达的或分支不匹配命令规则", async () => {
	const request = await bashRequest("cd ./build || exit 1 || git push; echo >report");
	expect(decide(request).kind).toBe("allow");
	expect(decide(request, withPathFact(`${request.cwd}/build/report`)).kind).toBe("deny");
	const mixed = await bashRequest("cd ./build || exit 1 && echo >report || git push");
	expect(decide(mixed)).toMatchObject({ kind: "ask", reason: "确认发布目标" });
});

it.each([
	"cd ./build || exit 1 >status",
	"exit() { return 1; }; cd ./build || exit 1",
	"trap 'echo cleanup' EXIT; cd ./build || exit 1",
])("不能证明失败出口不可达时仍检查右侧命令：%s", async (prefix) => {
	const request = await bashRequest(`${prefix} || git push`);
	expect(decide(request)).toMatchObject({ kind: "ask", reason: "确认发布目标" });
});

it("发布脚本只按同一分支实际可能写入的报告路径审批", async () => {
	const script = 'if test -f release; then dir=dist; file=report.csv; else dir=preview; file=draft.csv; fi; echo done >"$dir/$file"';
	const request = await bashRequest(script);
	expect(decide(request, withPathFact("**/dist/draft.csv")).kind).toBe("allow");
	expect(decide(request, withPathFact("**/dist/report.csv"))).toMatchObject({ kind: "deny", rule_name: "protected" });
});

it("间接调用的各个候选命令都参与审批，不能单独记忆", async () => {
	const request = await bashRequest('if test -n "$X"; then cmd=/bin/printf; else cmd=echo; fi; "$cmd" ok');
	for (const command of [["printf", "ok"], ["echo", "ok"]] as const) {
		fixture.config.tools.shell.facts.custom = { action: "ask", reason: "Review the command target.", commands: [{ classifier: "candidate", command }] };
		expect(decide(request)).toMatchObject({ kind: "ask", items: [{ unit: { remember: false } }] });
	}
});

it("按分支选择子脚本时，管道规则仍能拒绝其中一个脚本", async () => {
	const nested = await bashRequest('if test -f release; then script="git archive HEAD | gzip"; else script="git status"; fi; bash -c "$script"');
	fixture.config.tools.shell.facts.archive = { action: "deny", reason: "禁止打包", commands: [
		{ classifier: "archive", pipeline: [{ command: ["git", "archive"] }, { command: ["gzip"] }] },
	] };
	expect(decide(nested)).toMatchObject({ kind: "deny", rule_name: "archive" });
});

it("仅定义发布函数不触发推送审批", async () => {
	expect(decide(await bashRequest("publish() { git push origin main; }; git status")).kind).toBe("allow");
});

it.each(['out=$(dir=inner; echo >"$dir/a")', 'cat <(dir=inner; echo >"$dir/a")'])("替换内共享状态，但不修改外层: %s", async (substitution) => {
	const request = await bashRequest(`dir=outer; ${substitution}; echo >"$dir/b"`);
	expect(decide(request).kind).toBe("allow");
	expect(request.units.filter((unit) => unit.action === "write_redirect").map((unit) => unit.target.value)).toEqual([
		`${request.cwd}/inner/a`, `${request.cwd}/outer/b`,
	]);
});

it.skipIf(process.platform === "win32")("case 按可达写入目标审批", async () => {
	const command = 'case "$MODE" in dev) echo >report;; prod) echo >$OUT;; esac';
	const protectedPath = `${commandCwd}/protected`;
	const config = withPathFact(protectedPath);
	const inspect = (MODE: string, env: NodeJS.ProcessEnv = {}) => bashRequest(command, { MODE, OUT: "protected", ...env });
	const dev = await inspect("dev");
	expect(decide(dev, config).kind).toBe("allow");
	expect(dev.detail.environment).toEqual({ MODE: "dev" });
	expect(dev.allowSessionMemory).toBe(false);
	expect(decide(await inspect("prod"), config).kind).toBe("deny");
	expect(decide(await inspect("dev", { SSH_CLIENT: "192.0.2.1 4000 22" }), config).kind).toBe("ask");
});

it("分支重定向的每个目标都匹配路径规则", async () => {
	const request = await bashRequest('if test -n "$X"; then out=a; else out=b; fi; log="${out}.log"; cd ./build && printf ok >"$log"');
	for (const file of ["a.log", "b.log"]) {
		expect(decide(request, withPathFact(`${request.cwd}/build/${file}`)).kind).toBe("deny");
	}
});

it.each([
	'out=old; case "$X" in a) out=protected ;& b) out="${out}.log";; *) out=other;; esac; echo >"$out"',
	'if test -n "$X"; then out=a; else out=b; fi; for i in 1 2; do echo >"$out"; out=protected.log; done',
	'out=old; if test -n "$X"; then out=a; elif out=protected.log; test -n "$Y"; then out=b; fi; echo >"$out"',
])("后继分支和循环轮次仍检查可能的写入目标: %s", async (command) => {
	const request = await bashRequest(command);
	expect(decide(request, withPathFact(`${request.cwd}/protected.log`)).kind).toBe("deny");
});

it.each([
	['case "$X" in a) op=printf;; *) op=echo;; esac; "$op" ok', "allow"],
	['if test -n "$X"; then cmd=echo; else cmd=git; fi; "$cmd" push', "ask"],
	['read unknown; if test -n "$X"; then op=printf; else op=echo; fi; "$op" "$unknown"', "ask"],
	['if test -n "$X"; then op=printf; else op=echo; fi; "$op" *.log', "ask"],
	['if test -n "$X"; then op=printf; else op=echo; fi; "$op" ok | cat', "ask"],
	['if test -n "$X"; then script="echo ok"; else script="git push"; fi; bash -c "$script"', "ask"],
	['if test -n "$X"; then out=a; fi; echo >"$out"', "ask"],
	['if test -n "$X"; then out=a; else out=b; fi; echo >$out', "ask"],
	['if test -n "$X"; then out=a; else out=b; fi; read out <input; echo >"$out"', "ask"],
	['if test -n "$X"; then out=a; else out=b; fi & echo >"$out"', "ask"],
	['if test -n "$X"; then out=a; else out=b; fi | cat; echo >"$out"', "ask"],
	['read unknown; cd "$unknown" && echo >file', "ask"],
	['if test -n "$X"; then script="echo a"; else script="echo b"; fi; bash -c "$script"', "allow"],
	[`case "$X" in ${Array.from({ length: 8 }, (_, i) => `${i}) out=${i};;`).join(" ")} *) out=other;; esac; echo >"$out"`, "ask"],
] as const)("按可能的分支判定: %s", async (command, kind) => {
	expect(decide(await bashRequest(command)).kind).toBe(kind);
});
