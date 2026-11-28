import "./fixture.ts";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { loadApprovalGateConfig } from "../../../src/harness/approval/config.ts";
import { buildPowerShellApprovalRequest } from "../../../src/harness/approval/request/powershell.ts";
import { evaluateGatePolicy } from "../../../src/harness/approval/rules/policy.ts";
import { SessionApprovalStore } from "../../../src/harness/approval/rules/store.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("opi-powershell-flow-");
preserveEnv("PI_APPROVAL_GATE_CONFIG");
beforeEach(async () => {
	const configPath = path.join(temp.path, "approval.jsonc");
	process.env.PI_APPROVAL_GATE_CONFIG = configPath;
	await writeFile(configPath, JSON.stringify({ tools: { shell: { facts: {
		published: { action: "deny", reason: "不得覆盖已发布的报告", path_globs: ["**/published.csv"] },
	} } } }));
});

async function decide(command: string, env: NodeJS.ProcessEnv = {}, store = new SessionApprovalStore()) {
	const request = await buildPowerShellApprovalRequest(command, { command, cwd: temp.path, env });
	return evaluateGatePolicy(request, await loadApprovalGateConfig(), store);
}

it("按本次环境选择输出文件，只拒绝覆盖已发布报告的分支", async () => {
	const script = `if ($env:MODE -eq 'preview') { $out='draft.csv' } else { $out='published.csv' }; Write-Output 'status,total' > $out`;
	expect((await decide(script, { MODE: "preview" })).kind).toBe("allow");
	expect(await decide(script, { MODE: "release" })).toMatchObject({ kind: "deny", rule_name: "published" });
});

it("逐个导出文件时，函数参数和 Join-Path 计算出的目标仍受保护", async () => {
	const script = `function Save-Report($name) { $out = Join-Path reports $name; Write-Output 'status,total' > $out }
foreach ($name in @('draft.csv', 'published.csv')) { Save-Report $name }`;
	expect(await decide(script)).toMatchObject({ kind: "deny", rule_name: "published" });
});

it("finally 中的写入也检查 try 中途失败时的目标", async () => {
	const script = `$out='published.csv'; try { Get-Item draft.csv -ErrorAction Stop; $out='draft.csv' } finally { Write-Output 'complete,1' >> $out }`;
	expect(await decide(script)).toMatchObject({ kind: "deny", rule_name: "published" });
});

it("有限循环中的 exit 不再审批后续迭代和循环后的写入", async () => {
	const script = `foreach ($file in @('draft.csv', 'published.csv')) { Write-Output report > $file; exit 0 }; Write-Output done > published.csv`;
	expect((await decide(script)).kind).toBe("allow");
});

it("try 中的 exit 只进入 finally，不继续 try、catch 或块后的语句", async () => {
	const script = `try { exit 0; Write-Output late > published.csv } catch { Write-Output error > published.csv } finally { Write-Output done > draft.csv }; Write-Output late > published.csv`;
	expect((await decide(script)).kind).toBe("allow");
	expect(await decide(script.replace("done > draft.csv", "done > published.csv"))).toMatchObject({ kind: "deny", rule_name: "published" });
});

it("子脚本队列满时仍检查外层后续操作和已经排队的脚本", async () => {
	const child = (code: string) => `pwsh -NoProfile -Command '${code}'`;
	const full = Array(32).fill(child("Get-Date")).join("; ");
	const write = "Write-Output done > published.csv";
	for (const script of [`${full}; ${write}`, `${child(write)}; ${full}`]) {
		expect(await decide(script)).toMatchObject({ kind: "deny", rule_name: "published" });
	}
	expect(await decide(full)).toMatchObject({ kind: "ask", items: [{ unit: { target: { value: child("Get-Date") } } }] });
});

it("字面量不会进入 catch，变量读取和方法参数仍可能失败", async () => {
	const guarded = (expr: string) => `try { ${expr} } catch { Write-Output done > published.csv }`;
	for (const literal of ["'ok'", '"ok"', "1"]) expect((await decide(guarded(literal))).kind).toBe("allow");
	for (const expr of ["$missing", "'x'.Substring(8)"]) expect(await decide(guarded(expr))).toMatchObject({ kind: "deny", rule_name: "published" });
});

it("回调按实际副作用传递状态，也检查后续迭代读取的值", async () => {
	const report = (body: string) => `$file='notes.txt'; Get-Process | ForEach-Object { ${body} }; Write-Output done > $file`;
	for (const body of ["Write-Output $_.Name", "$other='draft.csv'", "return $_.Name"]) expect((await decide(report(body))).kind, body).toBe("allow");
	expect(await decide(report("$file='published.csv'"))).toMatchObject({ kind: "deny", rule_name: "published" });
	const growing = "$s='head'; Get-Process | ForEach-Object { $s=$s+'x' }";
	expect((await decide(`${growing}; Write-Output done > notes.csv`)).kind).toBe("allow");
	expect(await decide(`${growing}; Write-Output done > published.csv`)).toMatchObject({ kind: "deny", rule_name: "published" });
	const repeated = "$file='notes.txt'; Get-Process | ForEach-Object { Write-Output done > $file; $file='published.csv' }";
	expect(await decide(repeated)).toMatchObject({ kind: "deny", rule_name: "published" });
});

it("类型检查的退出码在运行时决定是否执行后续测试，两条路径都要审批", async () => {
	const guard = "bun run typecheck; if ($LASTEXITCODE) { exit $LASTEXITCODE }";
	expect((await decide(`${guard}; bunx --no-install vitest run tests/gui/host/host.test.ts -t '启动自动加载历史'`)).kind).toBe("allow");
	const pushApproval = { kind: "ask", items: [{ unit: { target: { value: "git push" } } }] };
	expect(await decide(`${guard}; git push`)).toMatchObject(pushApproval);
	expect(await decide("bun run typecheck; if ($LASTEXITCODE) { git push; exit $LASTEXITCODE }")).toMatchObject(pushApproval);
	expect(await decide("Set-StrictMode -Version Latest; try { if ($LASTEXITCODE) { exit 1 } } catch { git push }")).toMatchObject(pushApproval);
});

it("构建和清理后按保存的变量退出，不因退出码未知而要求整条确认", async () => {
	const config = "dist/playwright.welcome-local.ts";
	const test = `try { bunx --no-install playwright test welcome.e2e.ts --config ${config}; $result = $LASTEXITCODE }`;
	const cleanup = `Remove-Item -LiteralPath ${config}`;
	expect((await decide(`${test} finally { ${cleanup} }; exit $result`)).kind).toBe("allow");
	const build = "$script = @'\nimport { build } from 'vite'; await build();\n'@; bun -e $script; if ($LASTEXITCODE) { exit $LASTEXITCODE }";
	expect((await decide(`${build}; ${test} finally { bun run build:gui; ${cleanup} }; exit $result`)).kind).toBe("allow");
	expect(await decide(`${test} finally { git push }; exit $result`)).toMatchObject({ kind: "ask", items: [{ unit: { target: { value: "git push" } } }] });
});

it("exit 读取普通变量时不要求整数，读取失败后的操作仍受审批", async () => {
	expect((await decide("$result = 'other'; exit ${result}")).kind).toBe("allow");
	expect((await decide("Set-Variable result other; exit $result")).kind).toBe("allow");
	const strict = "Set-StrictMode -Version Latest";
	for (const script of ["try { exit $missing } catch { git push }", "exit $missing; git push"]) {
		expect(await decide(`${strict}; ${script}`)).toMatchObject({ kind: "ask", items: [{ unit: { target: { value: "git push" } } }] });
	}
	expect(await decide("exit $(Write-Output done > published.csv)")).toMatchObject({ kind: "deny", rule_name: "published" });
	expect((await decide("exit ${env:RESULT}")).kind).toBe("allow");
	expect((await decide("exit ($env:RESULT + 1)")).kind).toBe("allow");
	expect(await decide("exit $(git push)")).toMatchObject({ kind: "ask", items: [{ unit: { target: { value: "git push" } } }] });
});

it("不为运行时比较询问，但检查条件、分支和异常处理中的操作", async () => {
	const condition = "$count -gt ($limit + 2)";
	expect((await decide(`if (${condition}) { Write-Output $count }`)).kind).toBe("allow");
	for (const script of [`if (${condition}) { git push }`, `if (${condition}) {} else { git push }`,
		"if ($(git push) -lt $limit) { Get-Date }", `try { ${condition} } catch { git push }`]) {
		expect(await decide(script), script).toMatchObject({ kind: "ask", items: [{ unit: { target: { value: "git push" } } }] });
	}
});

it("普通参数候选超出预算时继续审批后面的操作", async () => {
	const setup = "if ($ready) { $v='A' } else { $v='B' }";
	expect((await decide(`${setup}; Write-Output $v $v $v $v $v`)).kind).toBe("allow");
	const names = ["$a", "$b", "$c", "$d", "$e"];
	const branches = names.map(n => `if ($ready) { ${n}='A' } else { ${n}='B' }`).join("; ");
	const report = `${branches}; Write-Output ${names.join(" ")}`;
	expect((await decide(report)).kind).toBe("allow");
	expect((await decide(`${branches}; Write-Output \"${names.join("-")}\"`)).kind).toBe("allow");
	expect(await decide(`${branches}; Get-Content ${names.join(" ")} .npmrc`)).toMatchObject({ kind: "deny", rule_name: "credential.read" });
	expect(await decide(`${report}; git push`)).toMatchObject({ kind: "ask", items: [{ unit: { target: { value: "git push" } } }] });
	expect(await decide(`${report}; Write-Output done > published.csv`)).toMatchObject({ kind: "deny", rule_name: "published" });
});

it("相同变量不能伪造参数组合，超预算的未知参数仍触发相关规则", async () => {
	await writeFile(path.join(temp.path, "approval.jsonc"), JSON.stringify({ tools: { shell: { facts: {
		report: { action: "deny", reason: "受保护的导出模式", commands: { report: { command: ["Export-Report", "A", "B"] } } },
		log: { action: "deny", reason: "受保护的列", commands: { log: { command: ["Show-Report", "*", "*", "*", "*", "Private"] } } },
	} } } }));
	const choice = "if ($ready) { $v='A' } else { $v='B' }";
	expect((await decide(`${choice}; Export-Report $v $v`)).kind).toBe("allow");
	expect(await decide(`${choice}; Export-Report $v B`)).toMatchObject({ kind: "deny", rule_name: "report" });
	const names = ["$a", "$b", "$c", "$d", "$e"];
	const branches = names.map(n => `if ($ready) { ${n}='Public' } else { ${n}='Private' }`).join("; ");
	expect(await decide(`${branches}; Show-Report ${names.join(" ")}`)).toMatchObject({ kind: "ask", items: [{ reason: expect.stringContaining("受保护的列") }] });
});

it("finally 检查退出分支的目标，但不把该分支的变量带回后续语句", async () => {
	const body = `if ($LASTEXITCODE -ne 0) { $file='published.csv'; exit 1 }; $file='draft.csv'`;
	expect(await decide(`try { ${body} } finally { Write-Output done > $file }`)).toMatchObject({ kind: "deny", rule_name: "published" });
	expect((await decide(`try { ${body} } finally { Write-Output done }; Write-Output done > $file`)).kind).toBe("allow");
});

it("同一作用域中新定义替换旧函数，条件定义则保留两个可达函数体", async () => {
	const first = "function Save-Report { Write-Output old > published.csv }";
	const second = "function Save-Report { Write-Output new > draft.csv }";
	expect((await decide(`${first}; ${second}; Save-Report`)).kind).toBe("allow");
	expect(await decide(`${first}; if ($LASTEXITCODE -eq 0) { ${second} }; Save-Report`)).toMatchObject({ kind: "deny", rule_name: "published" });
});

it("循环内有另一条路径可提前跳出时，仍审批循环后的写入", async () => {
	const script = `foreach ($n in @(1, 2)) { if ($LASTEXITCODE -eq 0) { break }; exit 1 }; Write-Output done > published.csv`;
	expect(await decide(script)).toMatchObject({ kind: "deny", rule_name: "published" });
});

it("跳过本轮仍可进入下一轮，经过 finally 的跳出保留清理后的状态", async () => {
	const loop = `foreach ($file in @('draft.csv', 'published.csv')) { if ($file -eq 'draft.csv') { continue }; Write-Output report > $file; exit 0 }`;
	expect(await decide(loop)).toMatchObject({ kind: "deny", rule_name: "published" });
	const cleanup = `foreach ($n in @(1)) { try { if ($LASTEXITCODE -eq 0) { break }; exit 0 } finally { $file='published.csv' } }; Write-Output done > $file`;
	expect(await decide(cleanup)).toMatchObject({ kind: "deny", rule_name: "published" });
});

it("嵌套 finally 按内外顺序传递退出状态，不恢复正常执行", async () => {
	const script = `$file='initial.csv'; try { try { exit 0 } finally { $file='draft.csv' }; Write-Output late > published.csv } finally { Write-Output done > $file }; Write-Output late > published.csv`;
	expect((await decide(script)).kind).toBe("allow");
	expect(await decide(script.replace("$file='draft.csv'", "$file='published.csv'"))).toMatchObject({ kind: "deny", rule_name: "published" });
});

it("函数调用还原局部变量和位置参数，环境赋值随调用返回", async () => {
	const script = `function Format-Report { $file='draft.csv'; $env:REPORT=$args[0] }
function Save-Report { $file=$args[0]; Format-Report 'draft.csv'; Write-Output done >>$file }`;
	expect(await decide(`${script}; Save-Report 'published.csv'`)).toMatchObject({ kind: "deny", rule_name: "published" });
	expect(await decide(`${script.replace('>>$file', '>> $args[0]')}; Save-Report 'published.csv'`)).toMatchObject({ kind: "deny", rule_name: "published" });
	expect(await decide(`${script}; Format-Report 'published.csv'; Write-Output done >>$env:REPORT`)).toMatchObject({ kind: "deny", rule_name: "published" });
});

it("调用默认别名后仍检查写入，不把同名函数的 exit 当作脚本已结束", async () => {
	const script = "function echo { exit 0 }; echo 'exporting report'; Write-Output done > published.csv";
	expect(await decide(script)).toMatchObject({ kind: "deny", rule_name: "published" });
});

it("函数内退出时，调用方的 finally 使用调用方变量和子调用修改后的环境", async () => {
	const script = `$file='draft.csv'; function Stop-Report { $file='published.csv'; $env:REPORT='published.csv'; exit 0 }; try { Stop-Report } finally { Write-Output done > $file }`;
	expect((await decide(script)).kind).toBe("allow");
	expect(await decide(script.replace('done > $file', 'done > $env:REPORT'))).toMatchObject({ kind: "deny", rule_name: "published" });
});

it("紧贴操作符的目标取重定向发生时的变量快照", async () => {
	expect((await decide(`$file='draft.csv'; Write-Output report >>$file; $file='published.csv'`)).kind).toBe("allow");
	expect(await decide(`$file='published.csv'; Write-Output report >>$file; $file='draft.csv'`)).toMatchObject({ kind: "deny", rule_name: "published" });
});

it("会话内已同意的推送不适用于切换目录或启动子 PowerShell 后的推送", async () => {
	const store = new SessionApprovalStore();
	const command = "git push";
	const request = await buildPowerShellApprovalRequest(command, { command, cwd: temp.path, env: {} });
	const decision = evaluateGatePolicy(request, await loadApprovalGateConfig(), store);
	if (decision.kind !== "ask") throw new Error("推送应当询问");
	store.prepareGrant(request, decision.items.map(({ unit }) => unit))?.();
	expect((await decide(command, {}, store)).kind).toBe("allow");
	expect((await decide("Set-Location repo; git push", {}, store)).kind).toBe("ask");
	expect((await decide("pwsh -NoProfile -Command 'git push'", {}, store)).kind).toBe("ask");
});

it("切回临时目录才能豁免 Git 清理，显式工作树仍需确认", async () => {
	const env = { WORKSPACE: path.resolve("repo") };
	expect((await decide("Push-Location $env:WORKSPACE; git clean -fd", env)).kind).toBe("ask");
	expect((await decide("Push-Location $env:WORKSPACE; Pop-Location; git clean -fd", env)).kind).toBe("allow");
	expect((await decide("git clean -fd", { GIT_WORK_TREE: env.WORKSPACE })).kind).toBe("ask");
});
