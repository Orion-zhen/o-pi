import { execFile, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { useTempDir } from "../helpers/lifecycle.js";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const piCli = path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const provider = path.resolve("tests/cli/fixtures/provider.ts");
const temp = useTempDir("opi-cli-");
let cwd: string;
let agentDir: string;
let env: Record<string, string>;

beforeEach(async () => {
	cwd = path.join(temp.path, "workspace");
	agentDir = path.join(temp.path, ".pi", "agent");
	env = {
		PATH: process.env.PATH ?? "",
		HOME: temp.path,
		USERPROFILE: temp.path,
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		NODE_NO_WARNINGS: "1",
		TERM: "xterm-256color",
	};
	await mkdir(cwd, { recursive: true });
	await mkdir(path.join(agentDir, "configs"), { recursive: true });
	await mkdir(path.join(agentDir, "agents"), { recursive: true });
	await writeFile(path.join(cwd, "sample.ts"), "export const value = 1;\n");
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "opi-fixture", defaultModel: "test", defaultThinkingLevel: "off",
		extensions: [provider], defaultTools: [], quietStartup: true, tuiMode: "fullscreen",
		compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
	await writeFile(path.join(agentDir, "agents", "scout.md"), "---\nname: scout\ndescription: Read a source file\ntools: read\n---\nInspect the assigned file.\n");
});

describe("opi CLI", () => {
	it.each([
		["--version"], ["--help", "-ne"], ["--thinking", "invalid"],
		["--mode", "invalid"], ["--session-id", "invalid"], ["--fork", "missing.jsonl", "--no-session"],
	].map((args) => ({ args })))("与 Pi 保持参数、帮助和错误输出一致: $args", ({ args }) => {
		const run = (entry: string) => spawnSync(process.execPath, [entry, ...args], {
			cwd, env, encoding: "utf8", timeout: 15_000,
		});
		const original = run(piCli);
		const integrated = run(cli);
		expect(integrated.error).toBeUndefined();
		expect(original.error).toBeUndefined();
		expect(integrated.status).toBe(original.status);
		expect(integrated.stdout).toBe(original.stdout);
		expect(integrated.stderr).toBe(original.stderr);
	});

	it("JSON 模式执行静态集成的文件工具、解析 worker、Bash 和写入保护", async () => {
		await writeFile(path.join(cwd, "large.ts"), "export const valueInWorker = 3;\n" + "// worker input\n".repeat(20_000));
		const events = await runJson("tools");
		const results = toolResults(events);
		expect(results.map((result) => result["toolName"])).toEqual(["ls", "find", "read", "grep", "edit", "write", "bash"]);
		expect(results.every((result) => !result["isError"]), JSON.stringify(results)).toBe(true);
		expect(JSON.stringify(results[0])).toContain("sample.ts");
		expect(JSON.stringify(results.at(-1))).toContain("opi-bash");
		expect(await readFile(path.join(cwd, "sample.ts"), "utf8")).toBe("export const value = 2;\n");
		expect(await readFile(path.join(cwd, "created.txt"), "utf8")).toBe("written by opi\n");
		expect(events.some((event) => event["type"] === "message_update")).toBe(true);
	});

	it.each([
		{ args: ["--tools", "read,grep"], expected: ["grep", "read"] },
		{ args: ["--no-tools"], expected: [] },
		{ args: ["--tools", "read,grep,edit", "--exclude-tools", "edit"], expected: ["grep", "read"] },
	])("工具参数保持有效: $args", async ({ args, expected }) => {
		const pending = exec(process.execPath, [cli, "--offline", "--approve", "--no-session", "-p", ...args, "inspect tools"], { cwd, env, timeout: 15_000 });
		pending.child.stdin?.end();
		const context = JSON.parse((await pending).stdout) as { tools?: Array<{ name: string }> };
		expect((context.tools ?? []).map((tool) => tool.name).sort()).toEqual(expected);
	});

	it("管道输入与命令行消息保持 Pi 的合并行为", async () => {
		const pending = exec(process.execPath, [cli, "--offline", "--approve", "--no-session", "-p", "cli marker"], { cwd, env, timeout: 15_000 });
		pending.child.stdin?.end("stdin marker\n");
		const output = (await pending).stdout;
		expect(output).toContain("stdin marker");
		expect(output).toContain("cli marker");
	});

	it("无界面审批仍阻止需要确认的工具", async () => {
		const results = toolResults(await runJson("approval"));
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ toolName: "bash", isError: true });
		expect(JSON.stringify(results[0])).not.toContain("PATH=");
	});

	it.each([false, true])("子代理重新启动 opi 并使用相同的静态工具和配置，fork=%s", async (fork) => {
		await writeFile(path.join(agentDir, "agents", "scout.md"), `---\nname: scout\ndescription: Read a source file\ntools: read\nfork: ${fork}\n---\nInspect the assigned file.\n`);
		const results = toolResults(await runJson("subagent", ["--tools", "read,subagent"]));
		expect(results).toHaveLength(1);
		expect(results[0], JSON.stringify(results)).toMatchObject({ toolName: "subagent", isError: false });
		const output = JSON.stringify(results);
		expect(output).toContain(cli);
		expect(output).toContain(fork ? "subagents" : "subagent_role");
		expect(output).toContain("value = 1");
	});

	it("保留 @file、prompt template、系统提示词参数和 print 模式", async () => {
		const promptPath = path.join(temp.path, "review.md");
		await writeFile(promptPath, "Review $1\n");
		await writeFile(path.join(cwd, "AGENTS.md"), "Project context marker.\n");
		const pending = exec(process.execPath, [cli, "--offline", "--approve", "--no-session", "-p",
			"--prompt-template", promptPath, "--system-prompt", "Custom role marker.",
			"--append-system-prompt", "Appended marker.", "@sample.ts", "/review file"], { cwd, env, timeout: 15_000 });
		pending.child.stdin?.end();
		const result = await pending;
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("Custom role marker.");
		expect(result.stdout).toContain("Appended marker.");
		expect(result.stdout).toContain("Project context marker.");
		expect(result.stdout).toContain("value = 1");
		expect(result.stdout).toContain("/review file");
		const template = exec(process.execPath, [cli, "--offline", "--approve", "--no-session", "-p", "--prompt-template", promptPath, "/review file"], { cwd, env, timeout: 15_000 });
		template.child.stdin?.end();
		expect((await template).stdout).toContain("Review file");
	});

	it("RPC 恢复会话、重新注册命令、切换思考级别且不重复注册", async () => {
		const client = new RpcClient({ cliPath: cli, cwd, env, args: ["--offline", "--approve"] });
		try {
			await client.start();
			const commands = (await client.getCommands()).map((command) => command.name);
			for (const name of ["tools", "system", "stats", "prune", "run", "usage", "telemetry", "opi-fixture"]) {
				expect(commands.filter((candidate) => candidate === name)).toHaveLength(1);
			}
			await client.setThinkingLevel("high");
			expect((await client.getState()).thinkingLevel).toBe("high");
			await client.promptAndWait("session marker", undefined, 15_000);
			const original = await client.getState();
			const text = await client.getLastAssistantText();
			expect(text).toContain("session marker");
			await client.newSession();
			expect((await client.getState()).messageCount).toBe(0);
			if (!original.sessionFile) throw new Error("Session file missing");
			await client.switchSession(original.sessionFile);
			expect(await client.getLastAssistantText()).toBe(text);
			expect((await client.getCommands()).filter((command) => command.name === "tools")).toHaveLength(1);
			await client.prompt("/opi-fixture-reload");
			expect((await client.getCommands()).filter((command) => command.name === "tools")).toHaveLength(1);
			expect(await client.getLastAssistantText()).toBe(text);
			expect(client.getStderr()).toBe("");
		} finally {
			await client.stop();
		}
	});

	it("-ne 关闭集成功能，-e 仍显式加载用户扩展", async () => {
		const client = new RpcClient({ cliPath: cli, cwd, env, args: ["--offline", "--approve", "-ne", "-e", provider] });
		try {
			await client.start();
			const commands = (await client.getCommands()).map((command) => command.name);
			expect(commands).toContain("opi-fixture");
			expect(commands).not.toContain("tools");
			expect(commands).not.toContain("telemetry");
		} finally {
			await client.stop();
		}
	});

	it.skipIf(process.platform !== "linux")("真实终端启动原 Pi TUI 并安装 o-pi 编辑器", async () => {
		const command = `stty cols 100 rows 35; exec '${process.execPath}' '${cli}' --offline --approve`;
		const pending = exec("/usr/bin/script", ["-qfec", command, "/dev/null"], {
			cwd, env: { ...env, PI_STARTUP_BENCHMARK: "1" }, timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
		});
		pending.child.stdin?.end();
		const result = await pending;
		expect(result.stdout).toContain("fixture-editor:custom");
		expect(result.stdout).not.toContain("initialization failed");
		expect(result.stdout).not.toContain("Failed to load extension");
	});
});

async function runJson(scenario: string, args: string[] = []): Promise<Record<string, unknown>[]> {
	const pending = exec(process.execPath, [cli, "--mode", "json", "--offline", "--approve", "--no-session", ...args, "Run the fixture"], {
		cwd, env: { ...env, PI_OPI_TEST_SCENARIO: scenario }, timeout: 25_000, maxBuffer: 4 * 1024 * 1024,
	});
	pending.child.stdin?.end();
	const result = await pending;
	expect(result.stderr).toBe("");
	return result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function toolResults(events: Record<string, unknown>[]): Record<string, unknown>[] {
	return events.flatMap((event) => {
		const message = event["message"];
		return event["type"] === "message_end" && typeof message === "object" && message !== null
			&& "role" in message && message.role === "toolResult" ? [message as Record<string, unknown>] : [];
	});
}
