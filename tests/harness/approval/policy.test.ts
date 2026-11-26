import "./fixture.ts";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadApprovalGateConfig } from "../../../src/harness/approval/config.ts";
import { buildWebFetchApprovalRequest } from "../../../src/harness/approval/pi/request.ts";
import { buildBashApprovalRequest } from "../../../src/harness/approval/request/bash/parse.ts";
import { evaluateBashGatePolicy, evaluateGatePolicy } from "../../../src/harness/approval/rules/policy.ts";
import { SessionApprovalStore } from "../../../src/harness/approval/rules/store.ts";
import type { ApprovalGateConfig, ApprovalRequest, BashApprovalRequest } from "../../../src/harness/approval/types.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

let dir: string;
let approvalStore: SessionApprovalStore;
let fixtureConfig: ApprovalGateConfig;
const temp = useTempDir("o-pi-approval-policy-");
const commandCwd = path.join(path.parse(process.cwd()).root, "workspace", "project");
const shellTempRoot = os.tmpdir().replaceAll("\\", "/");
preserveEnv("PI_APPROVAL_GATE_CONFIG");

beforeEach(async () => {
	dir = temp.path;
	approvalStore = new SessionApprovalStore();
	process.env.PI_APPROVAL_GATE_CONFIG = path.join(dir, "approval.jsonc");
	fixtureConfig = await loadApprovalGateConfig();
});

describe("approval policy", () => {
	it("Bash 默认拒绝也阻止临时目录中的清理命令", async () => {
		const request = await bashRequest(`rm -rf "${path.join(os.tmpdir(), "build")}"`);
		fixtureConfig.tools.bash.default_action = "deny";
		expect(decide(request)).toMatchObject({ kind: "deny", rule_name: "default-bash-policy" });
	});

	it("多个事实和组合对同一单元只产生一次审批", async () => {
		const request = await bashRequest("git push origin main");
		const config = structuredClone(fixtureConfig);
		const reason = "用户规则; 保留完整原因";
		config.tools.bash.facts["custom.push"] = {
			action: "ask", reason, commands: [{ classifier: "push", command: ["git", "push"] }],
		};
		config.tools.bash.default_action = "ask";
		config.tools.bash.combinations["custom-combination"] = { all: ["custom.push", "release"], action: "ask", reason: "Review the destination." };
		const first = decide(request, config);
		if (first.kind !== "ask") throw new Error("missing ask decision");
		expect(first.items).toHaveLength(1);
		expect(first.items[0]?.reason).toBe(`确认发布目标; ${reason}; Review the destination.`);
	});

	it.each(["echo hello", "x=1"])("Bash 默认动作要求审批：%s", async (command) => {
		const request = await bashRequest(command);
		const config = structuredClone(fixtureConfig);
		config.tools.bash.default_action = "ask";

		expect(decide(request, config)).toMatchObject({
			kind: "ask",
			reason: "This tool requires approval by default.",
		});
	});

	it("单个目标命中多个询问事实时合并原因，不再使用默认拒绝", () => {
		const origin = "http://10.0.0.1";
		const request = buildWebFetchApprovalRequest(commandCwd, { scope: "private", origin, url: origin, addresses: ["10.0.0.1"] });
		const policy = fixtureConfig.tools.webfetch;
		policy.default_action = "deny";
		policy.facts.audit = { match_all: true, action: "ask", reason: "audit" };
		policy.facts.internal = { network_scope: "private", action: "ask", reason: "audit" };
		const reason = "确认内网地址; audit";
		expect(decide(request)).toEqual({ kind: "ask", reason, items: [{ unit: request.unit, reason }] });
	});

	it("自定义拒绝规则匹配 env 包装的安装命令", async () => {
		fixtureConfig.tools.bash.facts["custom.package-deny"] = {
			action: "deny", reason: "Package installation is disabled.",
			commands: [{ classifier: "npm", command: ["npm", "install"] }],
		};

		expect(decide(await bashRequest("env NODE_ENV=test npm --prefix app install lodash"))).toMatchObject({ kind: "deny", rule_name: "custom.package-deny" });
		expect(decide(await bashRequest("npm --prefix app run install"))).toEqual({ kind: "allow" });
	});

	it.each(["linux", "darwin", "win32"] as const)("平台限定分类器只在目标平台产生事实: %s", async (platform) => {
		await writeFile(path.join(dir, "approval.jsonc"), JSON.stringify({ tools: { bash: { facts: {
			"custom.platform": { action: "deny", reason: "Tool disabled on this platform.", commands: { only: { platform, command: ["example-tool"] } } },
		} } } }));
		const request = await bashRequest("example-tool");
		expect(decide(request, await loadApprovalGateConfig())).toEqual(
			platform === process.platform
				? { kind: "deny", reason: "Tool disabled on this platform.", rule_name: "custom.platform" }
				: { kind: "allow" },
		);
	});

	it("Windows 服务审批按平台匹配，不区分操作名大小写", async () => {
		const requests = await Promise.all(["SC.EXE StArT Example", "SC STOP Example"].map((command) => bashRequest(command)));
		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		try {
			await writeFile(path.join(dir, "approval.jsonc"), JSON.stringify({ tools: { bash: { facts: {
				service: { action: "ask", reason: "确认服务操作", commands: { custom: { platform: "win32", command: ["{sc,sc.exe}", "{start,stop}"] } } },
			} } } }));
			const custom = await loadApprovalGateConfig();
			for (const request of requests) expect(decide(request, custom).kind).toBe("ask");
		} finally {
			platform.mockRestore();
		}
	});

	it("后续候选超限时，先前已确定的写入目标仍能触发拒绝", async () => {
		const branches = ["a", "b", "c", "d"].map((name) => `if test -f flag; then ${name}=x; else ${name}=y; fi`);
		const request = await bashRequest(['echo >report', ...branches, 'echo "$a$b$c$d"'].join("; "));
		expect(decide(request)).toMatchObject({ kind: "ask", reason: "确认动态命令" });
		expect(decide(request, withPathFact(`${request.cwd}/report`, "deny", "report"))).toMatchObject({ kind: "deny", rule_name: "report" });
	});

	it.skipIf(process.platform === "win32")("cd 失败后退出时，不可达的或分支不匹配命令规则", async () => {
		const command = "cd ./build || exit 1 || echo skipped >unused; echo >report";
		const request = await bashRequest(command);
		expect(request.units.map(({ target }) => target.value)).toEqual(["cd ./build", "exit 1", "echo", `${request.cwd}/build/report`]);
		const skipped = { action: "deny" as const, reason: "Unexpected branch.", commands: [{ classifier: "echo", command: ["echo", "skipped"] as const }] };
		expect(decide(request, withBashPolicy({ facts: { skipped }, combinations: {}, default_action: "allow" })).kind).toBe("allow");

		const mixed = await bashRequest("cd ./build || exit 1 && echo >report || echo retry");
		expect(mixed.units.map(({ target }) => target.value)).toEqual(["cd ./build", "exit 1", "echo", `${request.cwd}/build/report`, "echo retry"]);
	});

	it.each([
		"cd ./build || exit 1 >status",
		"exit() { return 1; }; cd ./build || exit 1",
		"trap 'echo cleanup' EXIT; cd ./build || exit 1",
	])("不能证明失败出口不可达时仍检查右侧命令：%s", async (prefix) => {
		const request = await bashRequest(`${prefix} || echo retry`);
		expect(request.units.map(({ target }) => target.value)).toContain("echo retry");
	});

	it.each([
		['src=report.ts; echo >"${src%.ts}.log"', "report.log"],
		['src=build/report.log; echo >"${src##*/}"', "report.log"],
		['src=prefix.report.log; echo >"${src#prefix.}"', "report.log"],
		['out=; echo >"${out:-report.log}"', "report.log"],
		['out=; echo >"x${out-report.log}"', "x"],
		['unset out; echo >"${out-report.log}"', "report.log"],
		['if test -n "$X"; then unset out; else out=report.log; fi; echo >"${out:-other.log}"', "other.log"],
		['cd ./build || exit 1; echo >report.log', "build/report.log"],
		['set -- old; set -- report.log; echo >"$1"', "report.log"],
		['set -- one a b c d e f g h ten; echo >"$10"', "one0"],
		['set -- one a b c d e f g h ten; echo >"${10}"', "ten"],
		['set -- report.log; f() { set -- local; }; f; echo >"$1"', "report.log"],
	] as const)("静态展开仍匹配目标路径规则: %s", async (script, target) => {
		const request = await bashRequest(script);
		expect(decide(request).kind).toBe("allow");
		expect(decide(request, withPathFact(`${request.cwd}/${target}`)).kind).toBe("deny");
	});

	it.each(["$?", "${?}", "$RANDOM", "$BASHPID", "$PPID", "$UID", "$EUID"])("数字 %s 不是精确路径", async (field) => {
		const request = await bashRequest(`bash -c 'echo >"run-${field}.log"'`);
		expect(request.units.at(-1)).toMatchObject({ target: { numericName: { prefix: "run-", suffix: ".log" } }, remember: false });
		expect(decide(request, withPathFact(`${request.cwd}/run-42.log`)).kind).toBe("deny");
		expect(decide(request, withPathFact(`${request.cwd}/run-x.log`)).kind).toBe("allow");
	});

	it.each([
		'read unknown; echo >"${unknown:-report.log}"', 'out=; echo >"${out:-$unknown}"', 'src=report.ts; echo >"${src%.*}"',
		'readonly out=locked; unset out; echo >"${out:-report.log}"', 'unset RANDOM; echo >"log-$RANDOM"', 'RANDOM=42; echo >"log-$RANDOM"',
		'sh -c \'echo >"$RANDOM.log"\'', 'set -- a b; set -- x; echo >"$2"', 'set -- a b; shift; echo >"$1"',
		'set -- *.log last; echo >"$2"', 'set -- a; f() { echo >"$1"; }; f',
		'read CDPATH; cd build; echo >report.log', 'cd ./build-*; echo >report.log', 'cd ./build; popd; echo >report.log',
		'while test -n "$more"; do cd ./build; done; echo >report.log',
		'cd ./a; cd ./b; cd ./c; cd ./d; echo >report.log',
	])("不能证明取值时仍审批: %s", async (script) => {
		expect(decide(await bashRequest(script)).kind).toBe("ask");
	});

	it("测试日志重定向按 PID 文件名而非精确路径审批", async () => {
		const root = shellTempRoot.includes(" ") ? `"${shellTempRoot}"` : shellTempRoot;
		const log = `${root}/opi-approval-baseline-$$.log`;
		const command = `node_modules/.bin/vitest run tests/harness/approval/{policy,request-builder}.test.ts --reporter=dot > ${log}; tail -12 ${log}`;
		const request = await bashRequest(command);
		const redirect = request.units.find((unit) => unit.action === "write_redirect");
		expect(redirect).toMatchObject({ target: { kind: "path", directory: shellTempRoot }, effect_scope: "temporary", remember: false });
		expect(decide(request).kind).toBe("allow");
		for (const [name, kind] of [
			["opi-approval-baseline-12345.log", "deny"], ["opi-approval-baseline-*.log", "deny"],
			["secret.log", "allow"], ["opi-approval-baseline-abc.log", "allow"], ["*.pem", "allow"],
		] as const) {
			expect(decide(request, withPathFact(`${shellTempRoot}/${name}`)).kind).toBe(kind);
		}
	});

	it.each([
		['echo >"进程-${$}.log"', "allow"],
		['log=run-$$.log; echo >"$log"', "allow"],
		['dir=logs; echo >"$dir/run-$$.log"', "allow"],
		['echo >$unknown-$$.log', "ask"],
		['echo >run-$$/child', "ask"],
		['echo >run-$$/*.log', "ask"],
		['runner=run-$$; "$runner" ok', "ask"],
	] as const)("PID 仅约束已知目录中的文件名: %s", async (command, kind) => {
		expect(decide(await bashRequest(command)).kind).toBe(kind);
	});

	it.skipIf(process.platform === "win32")("后台构建日志和退出状态按可能的写入目标评估", async () => {
		const request = await bashRequest('log=$(mktemp /tmp/comfyui-thor-build.XXXXXX); (docker compose --progress plain build --no-cache comfyui >"$log" 2>&1; echo $? >"${log}.exit") </dev/null >/dev/null 2>&1 & echo "$log"');
		expect(decide(request)).toEqual({ kind: "allow" });
		const fallback = path.join(commandCwd, ".exit");
		for (const glob of [fallback, "/tmp/comfyui-thor-build.123456.exit"]) {
			const config = withPathFact(glob);
			expect(decide(request, config)).toMatchObject({ kind: "deny", rule_name: "protected" });
		}
	});

	it.skipIf(process.platform === "win32")("只有空输出对应的目标命中系统目录时，只询问该目标", async () => {
		const request = await bashRequest('f=$(mktemp /tmp/run.XXXXXX); echo ok >"${f}.status"', "/etc");
		expect(decide(request, withPathFact("/etc/**", "ask"))).toMatchObject({ kind: "ask", items: [{
			unit: { target: { kind: "path", value: "/etc/.status" } },
		}] });
	});

	it.skipIf(process.platform === "win32")("变量别名和已知片段保留目录约束，不继承新文件身份", async () => {
		const command = 'f=$(mktemp "/etc/app.XXXXXX"); ext=.status; name="${f}${ext}"; alias="$name"; echo ok >"$alias"';
		const request = await bashRequest(command);
		expect(decide(request, withPathFact("/etc/**", "ask"))).toMatchObject({ kind: "ask", items: [{ unit: {
			target: { kind: "path", directory: "/etc" }, remember: false,
		} }] });
		expect(request.units).toContainEqual(expect.objectContaining({ target: { kind: "path", value: path.join(commandCwd, ".status") } }));
	});

	it.each([
		'read unknown; f=$(mktemp /tmp/app.XXXXXX); echo ok >"${f}${unknown}"',
		'f=$(mktemp /tmp/app.XXXXXX); echo ok >"${f}/../../etc/config"',
		'mktemp() { echo /etc/config; }; f=$(mktemp /tmp/app.XXXXXX); echo ok >"${f}.state"',
		'if test -n "$X"; then f=$(mktemp /etc/app.XXXXXX); else f=$(mktemp /tmp/app.XXXXXX); fi; echo ok >"${f}.state"',
	])("无法证明目录约束时仍审批: %s", async (command) => {
		expect(decide(await bashRequest(command))).toMatchObject({ kind: "ask", reason: "确认动态命令" });
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
		expect(decide(request)).toEqual({ kind: "allow" });
	});

	it.each([
		["mktemp 静态模板", `tmp=$(mktemp /tmp/pi-XXXX.ts)\ncat > "$tmp"\nrm -f "$tmp"`],
		["安全重赋值", `tmp="${shellTempRoot}/a"\ntmp="${shellTempRoot}/b"\nrm -rf "$tmp"`],
		["声明式赋值", `readonly tmp=$(mktemp -d)\nrm -rf "$tmp"`],
		["分支合并", `if test -n x; then tmp="${shellTempRoot}/a"; else tmp="${shellTempRoot}/b"; fi\nrm -rf "$tmp"`],
		["EXIT trap", `cleanup() { rm -rf "$tmp"; }\ntrap cleanup EXIT\ntmp=$(mktemp -d)`],
		["Git 临时工作区", `tmp=$(mktemp -d)\ngit -C "$tmp" clean -fd`],
		["包装 cd", `tmp=$(mktemp -d)\n(command cd "$tmp" && rm -rf .)`],
		["嵌套 Shell cwd", `tmp=$(mktemp -d)\n(cd "$tmp" && bash -c "rm -rf .")`],
		["嵌套 Shell 参数", `bash -c 'rm -rf "$1"' _ "${shellTempRoot}/pi-approval-work"`],
		["受限参数展开", `tmp=$(mktemp -d)\nrm -rf "\${tmp:?}/child"`],
		["临时路径 glob", `rm -rf ${shellTempRoot}/pi-approval-*`],
		["未调用函数", "publish() { git push origin main; }\necho ok"],
		["已清除 EXIT trap", "trap 'git push origin main' EXIT\ntrap - EXIT\necho ok"],
	] as const)("可证明局部副作用时默认放行: %s", async (_name, command) => {
		expect(decide(await bashRequest(command))).toEqual({ kind: "allow" });
	});

	it("短路失败没有注册 EXIT 清理，也不读取 cache 的启动值", async () => {
		const command = `cache=$(mktemp -d) && export PLAYWRIGHT_BROWSERS_PATH="$cache" && trap 'rm -rf "$cache"' EXIT && bun run playwright install --only-shell chromium && bun run playwright test`;
		for (const env of [{}, { cache: "/workspace/old" }]) {
			const request = await bashRequest(command, commandCwd, env);
			expect(request.detail.environment).toBeUndefined();
			expect(decide(request)).toEqual({ kind: "allow" });
		}
	});

	it("不同 EXIT 动作只读取各自可达的变量，并跟踪注册后的赋值", async () => {
		const request = await bashRequest(`
if test -f flag; then v=first; trap 'printf a "$v:$suffix"' EXIT; else v=second; trap 'printf b "$v:$suffix"' EXIT; fi
suffix=done`);
		const calls = request.units.flatMap((unit) => unit.commands ?? []).filter(([program]) => program === "printf");
		expect(calls.sort()).toEqual([["printf", "a", "first:done"], ["printf", "b", "second:done"]]);
	});

	it.each([
		`cache=$(mktemp -d) && trap 'rm -rf "$cache"' EXIT; cache=/workspace/data`,
		`cache=$(mktemp -d) && trap 'rm -rf "$cache"' EXIT; if test -f flag; then cache=/workspace/data; fi`,
		`cache=$(mktemp -d) && trap 'rm -rf "$cache"' EXIT; read cache`,
		`prepare() { read cache; }; run() { prepare; }; cache=$(mktemp -d) && trap 'rm -rf "$cache"' EXIT; run`,
		`cache=/workspace/data; trap 'rm -rf "$cache"' EXIT; test -f ready || exit 1; cache=$(mktemp -d)`,
	])("注册后清理目标不再保证是临时目录时仍审批: %s", async (command) => {
		expect(decide(await bashRequest(command))).toMatchObject({ kind: "ask", reason: "确认清理范围" });
	});

	it("if 条件成功注册的 EXIT 动作不继承失败分支的工作目录", async () => {
		const request = await bashRequest(`cache=$(mktemp -d); if cd "$cache" && test -f ready; then trap 'rm -rf ./cache' EXIT; fi`);
		expect(decide(request)).toEqual({ kind: "allow" });
	});

	it("同一 EXIT 动作仍检查可达的启动值", async () => {
		const request = await bashRequest(`if test -f ready; then cache=$(mktemp -d); fi; trap 'rm -rf "$cache"' EXIT`, commandCwd, { cache: "/workspace/archive" });
		expect(request.detail.environment).toEqual({ cache: "/workspace/archive" });
		expect(decide(request)).toMatchObject({ kind: "ask", reason: "确认清理范围" });
	});

	it("EXIT 动作超出分支预算时不按部分结果放行", async () => {
		const cases = Array.from({ length: 9 }, (_, i) => `${i}) trap 'echo ${i}' EXIT;;`);
		const request = await bashRequest(`read mode; case "$mode" in ${cases.join(" ")} esac`);
		expect(decide(request)).toMatchObject({ kind: "ask", reason: "确认动态命令" });
	});

	it("deny 安全事实仍可阻止 temporary 单元", async () => {
		const policy = structuredClone(fixtureConfig.tools.bash);
		policy.facts["custom.no-rm"] = { action: "deny", reason: "Deletion disabled.", commands: [{ classifier: "rm", command: ["rm"] }] };
		const request = await bashRequest(`tmpdir=$(mktemp -d)\nrm -rf "$tmpdir"`);
		expect(evaluateBashGatePolicy(request, withBashPolicy(policy), approvalStore).decision).toMatchObject({
			kind: "deny",
			rule_name: "custom.no-rm",
		});
	});

	it("有限候选分别检查原文、展开后的命令和子脚本，不记忆间接调用", async () => {
		const request = await bashRequest('if test -n "$X"; then cmd=/bin/printf; else cmd=echo; fi; "$cmd" ok');
		for (const command of [["printf", "ok"], ["echo", "ok"]] as const) {
			const policy = structuredClone(fixtureConfig.tools.bash);
			policy.facts.custom = { action: "ask", reason: "Review the command target.", commands: [{ classifier: "candidate", command }] };
			expect(evaluateBashGatePolicy(request, withBashPolicy(policy), approvalStore).decision).toMatchObject({ kind: "ask", items: [{ unit: { remember: false } }] });
		}
		const nested = await bashRequest('if test -n "$X"; then script="printf ok | cat"; else script="echo ok"; fi; bash -c "$script"');
		const policy = structuredClone(fixtureConfig.tools.bash);
		policy.facts.custom = { action: "deny", reason: "Pipeline disabled.", commands: [{ classifier: "pipeline", pipeline: [["printf", "ok"], ["cat"]] }] };
		expect(evaluateBashGatePolicy(nested, withBashPolicy(policy), approvalStore).decision.kind).toBe("deny");
	});

	it("系统临时目录后代中的递归删除默认放行，但目录根本身仍询问", async () => {
		const tempRoot = os.tmpdir();
		expect(decide(await bashRequest(`rm -rf "${path.join(tempRoot, "pi-approval", "work")}"`))).toEqual({ kind: "allow" });
		expect(decide(await bashRequest(`rm -rf "${tempRoot}"`))).toMatchObject({ kind: "ask" });
	});

	it("默认要求审批时，临时目录中的 rmdir -p 不享受临时范围豁免", async () => {
		fixtureConfig.tools.bash.default_action = "ask";
		const target = `"${shellTempRoot}/prototype/output"`;
		expect(decide(await bashRequest(`rmdir ${target}`)).kind).toBe("allow");
		expect(decide(await bashRequest(`rmdir -p ${target}`)).kind).toBe("ask");
	});

	it("目录名不是临时豁免的依据", async () => {
		expect(decide(await bashRequest("rm -rf var/tmp/pi-approval-work")).kind).toBe("ask");
	});

	it.each(['out=$(dir=inner; echo >"$dir/a")', 'cat <(dir=inner; echo >"$dir/a")'])("替换内共享状态，但不修改外层: %s", async (substitution) => {
		const request = await bashRequest(`dir=outer; ${substitution}; echo >"$dir/b"`);
		expect(decide(request).kind).toBe("allow");
		expect(request.units.filter((unit) => unit.action === "write_redirect").map((unit) => unit.target.value)).toEqual([
			`${request.cwd}/inner/a`, `${request.cwd}/outer/b`,
		]);
	});

	it.each(['cd ./build', 'cd ./build || exit 1 >exit.log', 'exit() { :; }; cd ./build || exit 1', 'change() { cd ./build; }; change'])("所有可达目录均参与后续路径判断: %s", async (prefix) => {
		const request = await bashRequest(`${prefix}; log="$PWD/report"; echo >"$log"; echo >other`);
		expect(decide(request).kind).toBe("allow");
		for (const parent of [request.cwd, `${request.cwd}/build`]) {
			for (const file of ["report", "other"]) {
				for (const action of ["deny", "ask"] as const) {
					expect(decide(request, withPathFact(`${parent}/${file}`, action)).kind).toBe(action);
				}
			}
		}
	});

	it.skipIf(process.platform === "win32")("CDPATH 检查所有搜索项和 cwd，前缀赋值只影响本次调用", async () => {
		const targets = async (command: string, cdpath?: string) => {
			const request = await bashRequest(command, commandCwd, { CDPATH: cdpath });
			return new Set(request.units.filter((unit) => unit.action === "write_redirect").map((unit) => unit.target.value));
		};
		const script = 'cd build; echo >report';
		expect(await targets(script)).toEqual(await targets('cd ./build; echo >report'));
		expect(await targets(script, "/opt:search:")).toEqual(new Set([`${commandCwd}/report`, `${commandCwd}/build/report`, "/opt/build/report", `${commandCwd}/search/build/report`]));
		expect(await targets('CDPATH=/override cd build && echo >a; echo >"$CDPATH/b"', "/original")).toEqual(new Set([`${commandCwd}/build/a`, "/override/build/a", "/original/b"]));
	});

	it("波浪号和无参数 cd 使用当前 HOME，失败路径保留原目录", async () => {
		const cwd = commandCwd.replaceAll("\\", "/");
		const home = `${cwd}/my home`;
		const local = `${cwd}/local`;
		for (const [command, targets, usesHome] of [
			['echo >~/a', [`${home}/a`], true],
			['cd && echo >a', [`${home}/a`], true],
			['set -- ~/a; echo >"$1"', [`${home}/a`], true],
			['cd; echo >a', [`${cwd}/a`, `${home}/a`], true],
			[`HOME=${local}; echo >~/a`, [`${local}/a`], false],
			[`HOME=${local} cd && echo >a; echo >~/b`, [`${local}/a`, `${home}/b`], true],
			['echo >"~/a"; echo >\\~/b', [`${cwd}/~/a`, `${cwd}/~/b`], false],
		] as const) {
			const request = await bashRequest(command, cwd, { HOME: home });
			expect(new Set(request.units.filter((unit) => unit.action === "write_redirect").map((unit) => unit.target.value))).toEqual(new Set(targets));
			expect(request.allowSessionMemory).toBe(!usesHome);
		}
	});

	it.each(['echo >~/a', 'cd && echo >a', 'unset HOME; echo >~/a', 'read HOME; cd && echo >a', 'echo >~user/a'])("HOME 不确定或波浪号指向其他用户时仍审批: %s", async (command) => {
		const env = command.startsWith("unset") || command.startsWith("read") ? { HOME: commandCwd } : {};
		const request = await bashRequest(command, commandCwd, env);
		expect(decide(request).kind).toBe("ask");
	});

	it.each([
		['echo >"${missing:-$OUT}"', "report file", { missing: null, OUT: "report file" }],
		['out=; echo >"${out:-$OUT}"', "report file", { OUT: "report file" }],
		['out=; echo >"a${out-$OUT}"', "a", undefined],
		['echo >"${OUT:-$UNUSED}"', "report file", { OUT: "report file" }],
		['set -- "$OUT"; set -- other "$1"; echo >"$2"', "report file", { OUT: "report file" }],
	] as const)("已知实参和按需展开的默认值参与路径审批: %s", async (command, file, environment) => {
		const request = await bashRequest(command, commandCwd, { OUT: "report file", UNUSED: "other" });
		expect(decide(request, withPathFact(`${request.cwd}/${file}`)).kind).toBe("deny");
		expect(request.detail.environment).toEqual(environment);
		expect(request.allowSessionMemory).toBe(environment === undefined);
	});

	it("启动环境只参与初值判断，赋值、失效和 Shell 自有变量不回读快照", async () => {
		for (const [command, action] of [
			['echo >"$OUT/report"', "allow"], ['OUT=local; echo >"$OUT/report"', "allow"],
			['read OUT; echo >"$OUT/report"', "ask"], ['source init.sh; echo >"$OUT/report"', "ask"],
			['echo >"$SECONDS"', "ask"], [': "${OUT:=changed}"; echo >"$OUT/report"', "ask"],
			['((OUT++)); echo >"$OUT/report"', "ask"], ['bash -c \'echo >"$OUT/report"\'', "ask"],
		] as const) {
			const request = await bashRequest(command, commandCwd, { OUT: "initial", SECONDS: "initial" });
			expect(decide(request).kind).toBe(action);
			expect(request.detail.environment).toEqual(command.startsWith('echo >"$OUT') ? { OUT: "initial" } : undefined);
		}
	});

	it.each([
		['unset out; echo >"${out:-report.log}"', undefined, true],
		['out=logs; echo >"$out/report"', "logs", true],
		['if true; then out=logs; fi; echo >"$out/report"', "logs", false],
		['if true; then unset out; fi; echo >"${out:-report.log}"', undefined, false],
	] as const)("会话记忆取决于变量来源而不是值是否相等: %s", async (command, out, independent) => {
		const request = await bashRequest(command, commandCwd, { out });
		expect(request.detail.environment).toEqual(independent ? undefined : { out: out ?? null });
		expect(request.allowSessionMemory).toBe(independent);
	});

	it("启动钩子不按无副作用的已知环境放行", async () => {
		const command = 'echo >"$OUT/report"';
		const request = await bashRequest(command, commandCwd, { OUT: "initial", BASH_ENV: "init.sh" });
		expect(decide(request).kind).toBe("ask");
		expect(request.detail.environment).toBeUndefined();
	});

	it.skipIf(process.platform === "win32").each([["日志/report", "allow"], ["report final", "ask"], ["*.log", "ask"]] as const)("未引用的输出路径按实际展开审批: %s", async (OUT, kind) => {
		const command = 'echo ready >$OUT';
		const request = await bashRequest(command, commandCwd, { OUT });
		expect(decide(request).kind).toBe(kind);
	});

	it.skipIf(process.platform === "win32")("case 按可达写入目标审批", async () => {
		const command = 'case "$MODE" in dev) echo >report;; prod) echo >$OUT;; esac';
		const protectedPath = `${commandCwd.replaceAll("\\", "/")}/protected`;
		const config = withPathFact(protectedPath);
		const inspect = (MODE: string, env: NodeJS.ProcessEnv = {}) => bashRequest(command, commandCwd, { MODE, OUT: "protected", ...env });
		const dev = await inspect("dev");
		expect(decide(dev, config).kind).toBe("allow");
		expect(dev.detail.environment).toEqual({ MODE: "dev" });
		expect(dev.allowSessionMemory).toBe(false);
		expect(decide(await inspect("prod"), config).kind).toBe("deny");
		expect(decide(await inspect("dev", { SSH_CLIENT: "192.0.2.1 4000 22" }), config).kind).toBe("ask");
	});

	it("分支重定向的每个目标都匹配路径规则", async () => {
		const request = await bashRequest('if test -n "$X"; then out=a; else out=b; fi; log="${out}.log"; cd ./build && printf ok >"$log"');
		const target = (file: string) => `${request.cwd}/build/${file}.log`;
		expect(decide(request)).toEqual({ kind: "allow" });
		for (const file of ["a", "b"]) {
			expect(decide(request, withPathFact(target(file), "ask", file))).toMatchObject({ kind: "ask", reason: file });
		}
		const config = withPathFact(target("b"), "ask", "b");
		config.tools.bash.facts.a = { commands: [], action: "deny", reason: "Protected output.", path_globs: [target("a")] };
		expect(decide(request, config)).toMatchObject({ kind: "deny", rule_name: "a" });
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

	it.each([
		`tmpdir=/etc\nrm -rf "$tmpdir"`,
		`tmpdir=$(mktemp -d)\nread tmpdir\nrm -rf "$tmpdir"`,
		`tmpdir=$(mktemp -d)\nsudo rm -rf "$tmpdir"`,
		`tmp='/tmp/a /etc'\nrm -rf $tmp`,
		'tmp=$(mktemp -d); git --no-optional-locks -C "$tmp" clean -fd',
		`if test -n "$X"; then cd /tmp/a && true; else cd /etc && true; fi\nrm -rf .`,
		`tmp=$(mktemp -d)\n(cd "$tmp" && bash -c 'cd /etc; rm -rf .')`,
		`tmp=/etc\ntest -n "$X" && tmp=/tmp/a\nrm -rf "$tmp"`,
		`tmp="/etc/$(mktemp)"\nrm -rf "$tmp"`,
	])("临时范围无法静态证明时仍询问: %s", async (command) => {
		expect(decide(await bashRequest(command))).toMatchObject({
			kind: "ask",
		});
	});

	it("路径事实和参数事实独立命中，可在同一次 Bash 调用中组合", async () => {
		await writeFile(path.join(dir, "approval.jsonc"), JSON.stringify({ tools: { bash: {
			facts: {
				output: { path_globs: [`${commandCwd}/report`] },
				argument: { commands: { report: { command: ["printf"], arg_globs: ["report"] } } },
			},
			combinations: { both: { all: ["output", "argument"], action: "deny", reason: "Report output is restricted." } },
		} } }));
		const config = await loadApprovalGateConfig();
		for (const [command, facts, decision] of [
			["printf report", ["argument"], { kind: "allow" }],
			["printf ok >report", ["output"], { kind: "allow" }],
			["printf report >report", ["output", "argument"], { kind: "deny", rule_name: "both", reason: "Report output is restricted." }],
		] as const) {
			const result = evaluateBashGatePolicy(await bashRequest(command), config, approvalStore);
			expect(result.bash.facts).toEqual(facts);
			expect(result.decision).toMatchObject(decision);
		}
	});

	it("发布规则禁用 Git、改用 Podman 后只询问 Podman 推送，并继承发布原因", async () => {
		await writeFile(path.join(dir, "approval.jsonc"), JSON.stringify({ tools: { bash: { facts: {
			release: { commands: { git: false, image: { command: ["podman", "push"] } } },
		} } } }));
		const request = await bashRequest("git push origin main && docker push example/app:latest && podman push example/app:latest");
		expect(decide(request, await loadApprovalGateConfig())).toMatchObject({
			kind: "ask", items: [{ unit: { target: { value: "podman push example/app:latest" } }, reason: "确认发布目标" }],
		});
	});

	it("清理工作区时预演无需审批，实际删除需要审批", async () => {
		expect(decide(await bashRequest("git -C repo clean -dfn"))).toEqual({ kind: "allow" });
		expect(decide(await bashRequest("git -C repo clean -fd"))).toMatchObject({ kind: "ask", reason: "确认清理范围" });
	});

	it("容器查询例外不放行另一分支上的删除操作", async () => {
		fixtureConfig.tools.bash.facts.containers = { action: "ask", reason: "确认容器操作", commands: [
			{ classifier: "docker", command: ["docker"], except: [["docker", "inspect"]] },
		] };
		const request = await bashRequest('if test -f .dry-run; then op=inspect; else op=rm; fi; docker "$op" app');
		expect(decide(request)).toMatchObject({ kind: "ask", items: [{ unit: { target: { value: 'docker "$op" app' } } }] });
	});

	it.each([
		["git -C status log", "ask"],
		['read dir; git -C "$dir" status', "allow"],
		['read dir; git -C $dir status', "ask"],
	] as const)("只在能确定 Git 子命令是 status 时豁免：%s", async (command, kind) => {
		const config = withBashPolicy({
			default_action: "allow", combinations: {}, facts: {
				review: { action: "ask", reason: "Review repository access.", commands: [{ classifier: "git", command: ["git"], except: [["git", "status"]] }] },
			},
		});
		expect(decide(await bashRequest(command), config).kind).toBe(kind);
	});

	it("从 JSONC 加载命令和管道规则，按参数边界及管道阶段匹配", async () => {
		await writeFile(path.join(dir, "approval.jsonc"), JSON.stringify({ tools: { bash: { facts: { release: {
			action: "deny", reason: "Release operations are disabled.", commands: {
				tag: { command: ["git", "tag", "stable"], exact: true },
				artifact: { command: ["cp"], arg_globs: ["dist/**"] },
				stream: { pipeline: [{ command: ["git", "archive"], arg_globs: ["HEAD"] }, ["gzip"]] },
			},
		} } } } }));
		const config = await loadApprovalGateConfig();
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
		[{ command: [] }], [{ pipeline: [["git", "archive"]] }],
		[{ command: ["docker"], except: ["inspect"] }],
		[{ command: ["cp"], exact: true, arg_globs: ["dist/**"] }],
	])("拒绝无效分类器 %j", async (rule) => {
		const file = path.join(dir, "approval.jsonc");
		process.env.PI_APPROVAL_GATE_CONFIG = file;
		await writeFile(file, JSON.stringify({ tools: { bash: { facts: { custom: { commands: { rule } } } } } }));
		await expect(loadApprovalGateConfig()).rejects.toThrow();
	});

	it.each([
		{ write: { facts: { locked: { action: "deny", match_all: true } } } },
		{ bash: { facts: { release: { reason: "  " } } } },
		{ bash: { combinations: { both: { all: ["cleanup", "release"], action: "ask" } } } },
	])("拒绝合并后缺少非空白原因的动作规则：%j", async (tools) => {
		await writeFile(path.join(dir, "approval.jsonc"), JSON.stringify({ tools }));
		await expect(loadApprovalGateConfig()).rejects.toThrow("merged config");
	});

	it("拒绝引用不存在的事实的组合", async () => {
		await writeFile(path.join(dir, "approval.jsonc"), JSON.stringify({ tools: { bash: { combinations: {
			publish: { all: ["release", "missing"], action: "deny", reason: "禁止发布" },
		} } } }));
		await expect(loadApprovalGateConfig()).rejects.toThrow("unknown fact");
	});
});

function decide(request: ApprovalRequest, config = fixtureConfig) {
	return evaluateGatePolicy(request, config, approvalStore);
}

function withBashPolicy(bash: ApprovalGateConfig["tools"]["bash"]) {
	return { ...fixtureConfig, tools: { ...fixtureConfig.tools, bash } };
}

function withPathFact(glob: string, action: "ask" | "deny" = "deny", id = "protected") {
	const config = structuredClone(fixtureConfig);
	config.tools.bash.facts[id] = { path_globs: [glob], commands: [], action, reason: id };
	return config;
}

function bashRequest(command: string, cwd = commandCwd, env: NodeJS.ProcessEnv = {}): Promise<BashApprovalRequest> {
	return buildBashApprovalRequest(command, { command, cwd, env }, { askpass: false });
}
