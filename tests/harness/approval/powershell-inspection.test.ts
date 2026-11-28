import "./fixture.ts";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { loadApprovalGateConfig } from "../../../src/harness/approval/config.ts";
import { buildPowerShellApprovalRequest } from "../../../src/harness/approval/request/powershell.ts";
import { evaluateGatePolicy } from "../../../src/harness/approval/rules/policy.ts";
import { SessionApprovalStore } from "../../../src/harness/approval/rules/store.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("opi-ps-inspect-");
preserveEnv("PI_APPROVAL_GATE_CONFIG");
beforeEach(() => { process.env.PI_APPROVAL_GATE_CONFIG = path.join(temp.path, "config.jsonc"); });

async function decide(command: string, env: NodeJS.ProcessEnv = {}) {
	const request = await buildPowerShellApprovalRequest(command, { command, cwd: temp.path, env });
	return evaluateGatePolicy(request, await loadApprovalGateConfig(), new SessionApprovalStore());
}

it("逐个检查仓库文件的行数和尾随空白，按路径审批而不预读内容", async () => {
	const command = `git -c core.safecrlf=false diff --check -- tests/harness/approval/policy.test.ts; foreach ($file in 'policy.test.ts','bash-paths.test.ts','bash-flow.test.ts','bash-cleanup.test.ts','policy-fixture.ts') { $lines = [IO.File]::ReadAllLines("$PWD/tests/harness/approval/$file"); "\${file}: $($lines.Length) lines"; if ($lines -match '\\s+$') { throw "trailing whitespace: $file" } }; git status --short -- tests/harness/approval; git write-tree`;
	expect((await decide(command)).kind).toBe("allow");
	expect((await decide(command.replace('[IO.File]::ReadAllLines("$PWD/tests/harness/approval/$file")', 'Get-Content -LiteralPath "$PWD/tests/harness/approval/$file"'))).kind).toBe("allow");
	expect(await decide(command.replace("'policy-fixture.ts'", "'.npmrc'"))).toMatchObject({ kind: "deny", rule_name: "credential.read" });
});

it("文本读取参与组合规则，内容决定的分支和异常清理都参与审批", async () => {
	const read = `$text = [System.IO.File]::ReadAllText('report.txt')`;
	expect(await decide(`${read.replace("report.txt", ".env")}; git push`)).toMatchObject({ kind: "deny", rule_name: "configuration.exfiltrate" });
	const branch = `if ($text -match 'error') { throw $text }`;
	expect(await decide(`${read}; ${branch}; git push`)).toMatchObject({ kind: "ask", items: [{ unit: { target: { value: "git push" } } }] });
	for (const clause of ["catch", "finally"]) {
		expect(await decide(`${read}; try { ${branch} } ${clause} { Get-Content .npmrc }`)).toMatchObject({ kind: "deny", rule_name: "credential.read" });
	}
});

it("切换 PowerShell 目录只影响 $PWD，不改变 .NET 相对路径的基准", async () => {
	await writeFile(path.join(temp.path, "config.jsonc"), JSON.stringify({ tools: { shell: { facts: {
		private: { action: "deny", reason: "保护仓库根目录的报告", commands: { read: { command: ["Get-Content"], arg_globs: [path.join(temp.path, "report.txt").replaceAll("\\", "/")] } } },
	} } } }));
	expect(await decide(`Set-Location reports; [IO.File]::ReadAllLines('report.txt')`)).toMatchObject({ kind: "deny", rule_name: "private" });
	expect(await decide(`Set-Location reports; [IO.File]::ReadAllLines("$PWD/.npmrc")`)).toMatchObject({ kind: "deny", rule_name: "credential.read" });
});

it("未知数据只在影响受保护的读取或执行目标时询问", async () => {
	const read = "$lines = [IO.File]::ReadAllLines('report.txt')";
	for (const command of [
		`${read}; Get-Content $lines`, `${read}; & $lines`,
		`[IO.File]::ReadAllLines($unknown)`, `[IO.File]::WriteAllText('report.txt', 'new')`,
	]) expect((await decide(command)).kind, command).toBe("ask");
	for (const command of [`${read}; git show \"$($lines.Length)\"`, `$data = Get-Item report.txt; \"$($data.Length)\"`]) {
		expect((await decide(command)).kind, command).toBe("allow");
	}
});

it("字面字符串处理和生成 GUID 不打断查询，结果不用于猜测执行或写入目标", async () => {
	for (const expr of ["' report '.Trim()", "('report').StartsWith($prefix)", "[guid]::NewGuid()", "[System.Guid]::NewGuid().ToString('N')"]) {
		expect((await decide(`$file='report.txt'; $value=${expr}; Write-Output done > $file`)).kind, expr).toBe("allow");
	}
	expect((await decide(`$file='report.txt'; Get-Process | Where-Object { 'opi'.Equals($_.Name) }; Write-Output done > $file`)).kind).toBe("allow");
	expect((await decide("$name=' report '.Trim(); & $name")).kind).toBe("ask");
	expect((await decide("$file=[guid]::NewGuid().ToString(); Write-Output done > $file")).kind).toBe("ask");
});

it("字符串方法不遮住接收方、参数或异常处理中的操作", async () => {
	for (const command of ["'report'.Contains($(git push))", '"$(git push)".Trim()', "try { 'short'.Substring(20) } catch { git push }"]) {
		expect(await decide(command), command).toMatchObject({ kind: "ask", items: [{ unit: { target: { value: "git push" } } }] });
	}
	expect(await decide("'report'.Contains($(Get-Content .npmrc))")).toMatchObject({ kind: "deny", rule_name: "credential.read" });
	for (const call of ["$obj.Trim()", "'report'.$method()", "'report'.ForEach($callback)", "'report'.GetType().GetMethods()", "Update-TypeData -PrependPath report.types.ps1xml; 'report'.Trim()", "[IO.File]::WriteAllText('report.txt','done')"]) {
		expect((await decide(call)).kind, call).toBe("ask");
	}
});

it("查询可用的 PowerShell 时，列表中的命令名仍参与策略匹配", async () => {
	const query = "Get-Command pwsh,powershell -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name";
	expect((await decide(query)).kind).toBe("allow");
	await writeFile(path.join(temp.path, "config.jsonc"), JSON.stringify({ tools: { shell: { facts: {
		lookup: { action: "ask", reason: "确认命令查询", commands: { legacy: { command: ["Get-Command", "powershell"] } } },
	} } } }));
	expect(await decide(query)).toMatchObject({ kind: "ask", reason: "确认命令查询" });
});

it("进程属性列表按静态字段匹配策略，不依赖运行时的 CPU 值", async () => {
	const processes = "Get-Process -Name opi -ErrorAction SilentlyContinue";
	const projection = `${processes} | Select Name,CPU`;
	expect((await decide(projection)).kind).toBe("allow");
	expect((await decide(`${processes} | Select-Object -Property Name,CPU`)).kind).toBe("allow");
	expect((await decide(`$dir='reports'; ${projection}; Write-Output done > "$dir/report.txt"`)).kind).toBe("allow");
	expect(await decide(`$file='.npmrc'; ${projection}; Get-Content $file`)).toMatchObject({ kind: "deny", rule_name: "credential.read" });
	const configPath = path.join(temp.path, "config.jsonc");
	for (const name of ["Select-Object", "Select"]) {
		await writeFile(configPath, JSON.stringify({ tools: { shell: { facts: {
			cpu: { action: "deny", reason: "限制进程 CPU 查询", commands: { usage: { pipeline: [["Get-Process"], { command: [name], arg_globs: ["CPU"] }] } } },
		} } } }));
		expect(await decide(projection)).toMatchObject({ kind: "deny", rule_name: "cpu" });
	}
});

it("动态列名不触发审批，重设别名、同名函数和计算属性里的调用仍受检查", async () => {
	const query = "Get-Date | Select Year,Month";
	expect((await decide(query)).kind).toBe("allow");
	expect((await decide(`Set-Alias Select Write-Output; ${query}`)).kind).toBe("ask");
	expect(await decide(`function Select-Object { Get-Content .npmrc }; ${query}`)).toMatchObject({ kind: "deny", rule_name: "credential.read" });
	expect((await decide("Get-Process | Select Name,$unknown")).kind).toBe("allow");
	expect(await decide("Get-Date | Select @{Name='Report';Expression={Get-Content .npmrc}}")).toMatchObject({ kind: "deny", rule_name: "credential.read" });
});

it("读取查询结果的属性不需要推断返回类型，属性接收者仍参与审批", async () => {
	expect((await decide("pwsh -NoProfile -Command '(Get-Command echo -CommandType Alias).Definition'")).kind).toBe("allow");
	expect((await decide("(Get-Command echo).Definition")).kind).toBe("allow");
	expect(await decide("(Get-History).CommandLine")).toMatchObject({ kind: "deny", rule_name: "history.read" });
});

it("筛选、排序和回调无需预先登记属性和参数，回调中的实际命令单独审批", async () => {
	const query = 'Get-Process | Where-Object { $_.WorkingSet -gt $threshold } | Sort-Object CPU -Descending';
	expect((await decide(`${query} | ForEach-Object { Write-Output $_.Id }`)).kind).toBe("allow");
	expect((await decide(`$dir='reports'; ${query}; Write-Output done > \"$dir/report.txt\"`)).kind).toBe("allow");
	expect(await decide(`${query} | ForEach-Object { git push }`)).toMatchObject({ kind: "ask", items: [{ unit: { target: { value: "git push" } } }] });
	for (const read of ["Get-Content .npmrc", "[IO.File]::ReadAllText('.npmrc')", "[IO.File]::ReadAllText($(Get-Content .npmrc))"]) {
		expect(await decide(`${query} | ForEach-Object { ${read} }`)).toMatchObject({ kind: "deny", rule_name: "credential.read" });
	}
});

it("未知参数只在可能命中已启用的命令或管道规则时询问", async () => {
	const report = 'Show-Report $column', query = `Get-Date | ${report}`;
	expect((await decide(query)).kind).toBe("allow");
	expect(await decide("git reset $mode")).toMatchObject({ kind: "ask", items: [{ reason: expect.stringContaining("cleanup") }] });
	expect((await decide("git reset -- $file")).kind).toBe("allow");
	for (const rule of [{ command: ["Show-Report", "Private"] }, { pipeline: [["Get-Date"], ["Show-Report", "Private"]] }]) {
		await writeFile(path.join(temp.path, "config.jsonc"), JSON.stringify({ tools: { shell: { facts: {
			private: { action: "deny", reason: "保护私有列", commands: { column: rule } },
		} } } }));
		expect(await decide(query)).toMatchObject({ kind: "ask", items: [{ reason: expect.stringContaining("保护私有列") }] });
		expect((await decide(`$column='Public'; ${report}`)).kind).toBe("allow");
		expect(await decide(query.replace("$column", "Private"))).toMatchObject({ kind: "deny", rule_name: "private" });
	}
});

it("管道中完整的确定匹配优先，可能匹配仍须保持阶段顺序", async () => {
	await writeFile(path.join(temp.path, "config.jsonc"), JSON.stringify({ tools: { shell: { facts: {
		export: { action: "deny", reason: "保护私有列", commands: { report: { pipeline: [["Show-Report", "Private"], ["Save-Report"]] } } },
	} } } }));
	const maybe = "Show-Report $column", exact = "Show-Report Private", save = "Save-Report";
	expect(await decide(`${maybe} | ${save} | ${exact} | ${save}`)).toMatchObject({ kind: "deny", rule_name: "export" });
	expect(await decide(`${maybe} | ${save} | ${exact}`)).toMatchObject({ kind: "ask", reason: expect.stringContaining("保护私有列") });
	expect((await decide(`${save} | ${maybe}`)).kind).toBe("allow");
});

it("Bun 从带空格的临时目录运行脚本时按展开后的路径审批", async () => {
	const env = { TEMP: "C:\\Local Temp" };
	const run = "$dir=Join-Path $env:TEMP reports; bun $dir/compare.ts";
	expect((await decide(run, env)).kind).toBe("allow");
	await writeFile(path.join(temp.path, "config.jsonc"), JSON.stringify({ tools: { shell: { facts: {
		runner: { action: "deny", reason: "禁止执行临时脚本", commands: { bun: { command: ["bun"], arg_globs: ["C:/Local Temp/reports/**"] } } },
	} } } }));
	expect(await decide(run, env)).toMatchObject({ kind: "deny", rule_name: "runner" });
	expect(await decide("bun $env:TEMP/reports/compare.ts", env)).toMatchObject({ kind: "deny", rule_name: "runner" });
});

it("查询应用路径不影响临时目录变量，只在使用未知的联接目标时询问", async () => {
	const env = { TEMP: temp.path };
	const prepare = '$p="$env:TEMP/opi-start"; $app=Resolve-Path dist/desktop/app; New-Item -ItemType Directory "$p/copy" | Out-Null';
	const junction = 'New-Item -ItemType Junction -Path "$p/copy/resources" -Target';
	expect((await decide(prepare, env)).kind).toBe("allow");
	const unknown = `${prepare}; ${junction} "$app/resources" | Out-Null`;
	const decision = await decide(unknown, env);
	expect(decision).toMatchObject({ kind: "ask", items: [{ unit: { analysisNote: expect.stringMatching(/Unresolved argument .*: "\$app\/resources"$/u) } }] });

	const rule = { action: "deny", reason: "保护联接路径", commands: { create: { command: ["New-Item"], arg_globs: ["**/copy/resources"] } } };
	await writeFile(path.join(temp.path, "config.jsonc"), JSON.stringify({ tools: { shell: { facts: { protected: rule } } } }));
	for (const command of [unknown, `${prepare}; New-Item -ItemType Junction -Path alias -Target "$p/copy/resources"`]) {
		expect(await decide(command, env)).toMatchObject({ kind: "deny", rule_name: "protected" });
	}
});

it("绝对目录路径仍受保护，带输出变量的路径查询不能保留旧值", async () => {
	await writeFile(path.join(temp.path, "config.jsonc"), JSON.stringify({ tools: { shell: { facts: {
		directory: { action: "deny", reason: "保护目录", path_globs: ["**/reports/published"] },
	} } } }));
	const create = 'New-Item -ItemType Directory -Path "$dir/published" | Out-Null';
	expect(await decide(`$dir='reports'; Resolve-Path .; ${create}`)).toMatchObject({ kind: "deny", rule_name: "directory" });
	expect((await decide(`$dir='drafts'; Resolve-Path . -OutVariable dir; ${create}`)).kind).toBe("ask");
});

it("输出变量只影响指定的变量，其他变量和相对路径仍然可用", async () => {
	const setup = "$file='notes.txt'; $dir='reports'";
	for (const run of ["bun args.ts", "& 'bun.exe' args.ts"]) {
		expect((await decide(`${setup}; ${run} -OutVariable file; Write-Output done > $file`)).kind).toBe("allow");
	}
	expect((await decide(`${setup}; Get-Report -OutVariable file; Write-Output done > $file`)).kind).toBe("ask");
	for (const option of ["-OutVariable file", "-OutV file", "-ov:+file"]) {
		const query = `${setup}; Get-Process ${option}`;
		expect((await decide(`${query}; Write-Output done > \"$dir/report.txt\"`)).kind).toBe("allow");
		expect(await decide(`${query}; Get-Content $file`)).toMatchObject({ kind: "ask", items: [{ unit: { target: { value: "Get-Content $file" } } }] });
	}
});

it.runIf(process.platform === "win32")("创建随机工作目录时按父路径审批，不因使用 TEMP 就豁免系统目录", async () => {
	await writeFile(path.join(temp.path, "config.jsonc"), JSON.stringify({ tools: { shell: { facts: {
		system: { action: "ask", reason: "确认写入系统目录", path_globs: ["%SystemRoot%/**"] },
	} } } }));
	const create = "$dir=Join-Path $env:TEMP ('reports-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $dir";
	expect((await decide(create, { TEMP: temp.path })).kind).toBe("allow");
	const systemRoot = process.env.SystemRoot;
	expect(await decide(create, { TEMP: systemRoot })).toMatchObject({ kind: "ask", items: expect.arrayContaining([
		expect.objectContaining({ unit: expect.objectContaining({ action: "create_directory" }) }),
	]) });
});
