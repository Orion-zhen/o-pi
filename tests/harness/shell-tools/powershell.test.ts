import path from "node:path";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, it, expect } from "vitest";
import shellTools from "../../../src/harness/extensions/shell-tools.ts";
import { registerExtension } from "../../helpers/extension.ts";
import { preserveEnv } from "../../helpers/lifecycle.ts";
import { loadedSkill, registeredShellTool, useShellWorkspace } from "./fixture.ts";

const temp = useShellWorkspace("opi-shell-ps-");
preserveEnv("PI_SHELL_TOOLS_CONFIG", "OPI_TEST_TOKEN");
function run(command: string, params: { workdir?: string; timeout?: number } = {}, branch: SessionEntry[] = [], signal?: AbortSignal, onUpdate?: () => void) {
	const tool = registeredShellTool("powershell");
	return tool.execute("ps-test", { command, ...params }, signal, onUpdate, { cwd: temp.path,
		sessionManager: { getSessionId: () => path.basename(temp.path), getSessionFile: () => undefined, getBranch: () => branch } });
}

it("仅在 Windows 注册 PowerShell 工具", () => {
	const { registered } = registerExtension(shellTools);
	expect(registered.map((tool) => tool.name).sort()).toEqual(process.platform === "win32" ? ["bash", "powershell"] : ["bash"]);
});

describe.runIf(process.platform === "win32")("PowerShell 本地后端", () => {
	it.each([
		["Get-Content 'skill://absent/README.md'", "SKILL_RESOURCE_ACCESS_DENIED"],
		['Get-Content skill://demo/SKILL.md; Get-Content "skill://demo/$file"', "INVALID_SKILL_RESOURCE"],
		["Write-Output ok > 'skill://demo/missing'", "INVALID_SKILL_RESOURCE"],
		["pwsh -Command { Get-Content 'skill://demo/SKILL.md' }", "INVALID_SKILL_RESOURCE"],
	])("技能路径不被允许时拒绝整条命令：%s", async (command, code) => {
		await writeFile(path.join(temp.path, "SKILL.md"), "demo");
		const result = await run(`Set-Content started.txt started; ${command}`, {}, loadedSkill(temp.path));
		expect(result.content[0]?.text).toContain(`<error tool="powershell" code="${code}">`);
		expect(result.structuredContent).toMatchObject({ exit_code: 126 });
		await expect(readFile(path.join(temp.path, "started.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("按 workdir、过滤环境和预算执行真实命令，失败保留完整日志", async () => {
		process.env.OPI_TEST_TOKEN = "private-value";
		process.env.PI_SHELL_TOOLS_CONFIG = path.join(temp.path, "shell-tools.jsonc");
		await writeFile(process.env.PI_SHELL_TOOLS_CONFIG, '{"limits":{"failure_output_bytes":1024}}');
		await mkdir(path.join(temp.path, "sub"));
		const result = await run("(Get-Location).Path; $env:PI_SESSION_ID; $env:OPI_TEST_TOKEN; 'x' * 2048; [Console]::Error.WriteLine('stderr'); exit 7", { workdir: "sub" });
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ output_state: "truncated", exit_code: 7 });
		const details = result.structuredContent;
		if (!details || typeof details !== "object" || !("full_output_path" in details) || typeof details.full_output_path !== "string") throw new Error("缺少日志");
		const output = await readFile(details.full_output_path, "utf8");
		expect(details).toMatchObject({ status: "exited", output, capture_complete: true });
		expect(output).toContain(path.join(temp.path, "sub"));
		expect(output).toContain(`\n${path.basename(temp.path)}`);
		expect(output).toContain("stderr");
		expect(output).not.toContain("private-value");
	});

	it("管道里的静态技能路径按 PowerShell 规则引用，保留 Unicode 和单引号", async () => {
		const root = path.join(temp.path, "skill's 示例’$data");
		await mkdir(root);
		await writeFile(path.join(root, "a b.txt"), "static-ok");
		const branch = loadedSkill(root);
		const result = await run(`Write-Output '开始🧪'; Get-Content -LiteralPath "skill://demo/a b.txt" | Write-Output`, {}, branch);
		expect(result.isError).toBe(false);
		expect(result.content[0]?.text).toContain("static-ok");
	});

	it("嵌套命令、点源和重定向使用本分支的静态技能资源", async () => {
		const root = path.join(temp.path, "示例's $skill");
		await mkdir(root);
		await writeFile(path.join(root, "init.ps1"), "function Format-Note($text) { Write-Output \"loaded-$text\" }");
		await writeFile(path.join(root, "input.txt"), "ok");
		await writeFile(path.join(root, "out log.txt"), "");
		const command = [
			". 'skill://demo/init.ps1'",
			"Format-Note $(Get-Content 'skill://demo/input.txt') >>'skill://demo/out log.txt'",
			"Get-Content -LiteralPath 'skill://demo/out log.txt'",
		].join("\n");
		const result = await run(command, {}, loadedSkill(root));
		expect(result.content[0]?.text).toContain("loaded-ok");
		expect(result.isError).toBe(false);
	});

	it("拒绝通配重定向和通过目录联接越界的点源，进程不启动", async () => {
		const root = path.join(temp.path, "demo"), other = path.join(temp.path, "other");
		await Promise.all([mkdir(root), mkdir(other)]);
		await symlink(other, path.join(root, "linked"), "junction");
		await writeFile(path.join(other, "report.ps1"), "'outside'");
		for (const name of ["report[1].txt", "report1.txt"]) await writeFile(path.join(root, name), "before");
		for (const [script, code] of [
			["Write-Output changed > 'skill://demo/report[1].txt'", "INVALID_SKILL_RESOURCE"],
			[". 'skill://demo/linked/report.ps1'", "SKILL_RESOURCE_ACCESS_DENIED"],
		]) {
			const result = await run(`Set-Content started.txt started; ${script}`, {}, loadedSkill(root));
			expect(result.content[0]?.text).toContain(`code="${code}"`);
			expect(result.structuredContent).toMatchObject({ exit_code: 126 });
		}
		await expect(readFile(path.join(temp.path, "started.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		for (const name of ["report[1].txt", "report1.txt"]) expect(await readFile(path.join(root, name), "utf8")).toBe("before");
	});

	it("超时和流式输出后的主动取消有不同的结构化状态", async () => {
		const command = "Write-Output 'started'; Start-Sleep -Seconds 30";
		expect((await run(command, { timeout: 0.1 })).structuredContent).toMatchObject({ status: "timed_out", exit_code: null });
		const controller = new AbortController();
		expect((await run(command, { timeout: 10 }, [], controller.signal, () => controller.abort())).structuredContent)
			.toMatchObject({ status: "aborted", output: expect.stringContaining("started"), exit_code: null });
	});
});
