import os from "node:os";
import { expect, it } from "vitest";
import { bashRequest, commandCwd, usePolicyFixture } from "./policy-fixture.ts";

const { decide, withPathFact } = usePolicyFixture();
const shellTempRoot = os.tmpdir().replaceAll("\\", "/");

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
	['set -- --output report.log; shift; echo done >"$1"', "report.log"],
	['files=(draft.log report.log); echo done >>"${files[1]}"', "report.log"],
	['out=report.log; preview() { local out=draft.log; echo preview >"$out"; }; preview; echo done >"$out"', "report.log"],
	['exec 3>report.log; echo done >&3', "report.log"],
	['out=report.log; prepare() { out=draft.log; }; ./prepare; echo done >"$out"', "report.log"],
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
	'sh -c \'echo >"$RANDOM.log"\'', 'set -- a b; set -- x; echo >"$2"', 'set -- a b; read count; shift "$count"; echo >"$1"',
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
	const command = `bun x vitest run tests/harness/approval > ${log}; tail -12 ${log}`;
	const request = await bashRequest(command);
	const redirect = request.units.find((unit) => unit.action === "write_redirect");
	expect(redirect).toMatchObject({ target: { kind: "path", directory: shellTempRoot }, effect_scope: "temporary", remember: false });
	expect(decide(request).kind).toBe("allow");
	for (const [name, kind] of [
		["opi-approval-baseline-12345.log", "deny"], ["opi-approval-baseline-*.log", "deny"],
		["opi-approval-baseline-abc.log", "allow"], ["*.pem", "allow"],
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

it.each(['cd ./build', 'change() { cd ./build; }; change'])("切换目录无论成功或失败，都检查后续写入：%s", async prefix => {
	const request = await bashRequest(`${prefix}; echo done >>"$PWD/report.log"`);
	for (const dir of [request.cwd, `${request.cwd}/build`]) {
		expect(decide(request, withPathFact(`${dir}/report.log`))).toMatchObject({ kind: "deny", rule_name: "protected" });
	}
});

it.skipIf(process.platform === "win32")("CDPATH 检查所有搜索项和 cwd，前缀赋值只影响本次调用", async () => {
	const targets = async (command: string, cdpath?: string) => {
		const request = await bashRequest(command, { CDPATH: cdpath });
		return new Set(request.units.filter((unit) => unit.action === "write_redirect").map((unit) => unit.target.value));
	};
	const script = 'cd build; echo >report';
	expect(await targets(script)).toEqual(await targets('cd ./build; echo >report'));
	expect(await targets(script, "/opt:search:")).toEqual(new Set([`${commandCwd}/report`, `${commandCwd}/build/report`, "/opt/build/report", `${commandCwd}/search/build/report`]));
	expect(await targets('CDPATH=/override cd build && echo >a; echo >"$CDPATH/b"', "/original")).toEqual(new Set([`${commandCwd}/build/a`, "/override/build/a", "/original/b"]));
});

it("波浪号和无参数 cd 使用当前 HOME，失败路径保留原目录", async () => {
	const cwd = commandCwd;
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
		const request = await bashRequest(command, { HOME: home });
		expect(new Set(request.units.filter((unit) => unit.action === "write_redirect").map((unit) => unit.target.value))).toEqual(new Set(targets));
		expect(request.allowSessionMemory).toBe(!usesHome);
	}
});

it.each(['echo >~/a', 'cd && echo >a', 'unset HOME; echo >~/a', 'read HOME; cd && echo >a', 'echo >~user/a'])("HOME 不确定或波浪号指向其他用户时仍审批: %s", async (command) => {
	const env = command.startsWith("unset") || command.startsWith("read") ? { HOME: commandCwd } : {};
	const request = await bashRequest(command, env);
	expect(decide(request).kind).toBe("ask");
});

it.each([
	['echo >"${missing:-$OUT}"', "report file", { missing: null, OUT: "report file" }],
	['out=; echo >"${out:-$OUT}"', "report file", { OUT: "report file" }],
	['out=; echo >"a${out-$OUT}"', "a", undefined],
	['echo >"${OUT:-$UNUSED}"', "report file", { OUT: "report file" }],
	['set -- "$OUT"; set -- other "$1"; echo >"$2"', "report file", { OUT: "report file" }],
] as const)("已知实参和按需展开的默认值参与路径审批: %s", async (command, file, environment) => {
	const request = await bashRequest(command, { OUT: "report file", UNUSED: "other" });
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
		const request = await bashRequest(command, { OUT: "initial", SECONDS: "initial" });
		expect(decide(request).kind).toBe(action);
		expect(request.detail.environment).toEqual(command.startsWith('echo >"$OUT') ? { OUT: "initial" } : undefined);
	}
});

it.each([
	['unset out; echo >"${out:-report.log}"', undefined, true],
	['out=logs; echo >"$out/report"', "logs", true],
	['if true; then out=logs; fi; echo >"$out/report"', "logs", true],
	['if test -f flag; then out=logs; fi; echo >"$out/report"', "logs", false],
	['if test -f flag; then unset out; fi; echo >"${out:-report.log}"', undefined, false],
] as const)("会话记忆取决于变量来源而不是值是否相等: %s", async (command, out, independent) => {
	const request = await bashRequest(command, { out });
	expect(request.detail.environment).toEqual(independent ? undefined : { out: out ?? null });
	expect(request.allowSessionMemory).toBe(independent);
});

it("启动钩子不按无副作用的已知环境放行", async () => {
	const command = 'echo >"$OUT/report"';
	const request = await bashRequest(command, { OUT: "initial", BASH_ENV: "init.sh" });
	expect(decide(request).kind).toBe("ask");
	expect(request.detail.environment).toBeUndefined();
});

it.skipIf(process.platform === "win32").each([["日志/report", "allow"], ["report final", "ask"], ["*.log", "ask"]] as const)("未引用的输出路径按实际展开审批: %s", async (OUT, kind) => {
	const command = 'echo ready >$OUT';
	const request = await bashRequest(command, { OUT });
	expect(decide(request).kind).toBe(kind);
});
