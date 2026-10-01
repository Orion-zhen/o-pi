import { buildSessionContext, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createCanvas } from "@napi-rs/canvas";
import { execFile } from "node:child_process";
import { constants, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTempDir } from "../helpers/lifecycle.ts";
import { startModelServer, type ModelRequest, type ModelResponse } from "./model-server.ts";
import { countTextTokensSync } from "../../src/harness/token-counter.ts";

const exec = promisify(execFile);
const builtCli = path.resolve(process.platform === "win32" ? "dist/tui/opi.exe" : "dist/tui/opi");
const piCli = path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const temp = useTempDir("opi-cli-");
let cli: string;
let cwd: string;
let agentDir: string;
let env: Record<string, string>;
let server: Awaited<ReturnType<typeof startModelServer>>;
let respond: (request: ModelRequest) => ModelResponse;

beforeEach(async () => {
	cwd = path.join(temp.path, "workspace");
	agentDir = path.join(temp.path, ".pi", "agent");
	cli = path.join(temp.path, path.basename(builtCli));
	await copyFile(builtCli, cli, constants.COPYFILE_FICLONE);
	respond = (request) => ({ text: JSON.stringify(request) });
	server = await startModelServer((request) => respond(request));
	env = {
		PATH: process.env.PATH ?? "", HOME: temp.path, USERPROFILE: temp.path,
		PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
		NODE_NO_WARNINGS: "1", TERM: "xterm-256color",
		...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
	};
	await mkdir(cwd, { recursive: true });
	await mkdir(path.join(agentDir, "configs"), { recursive: true });
	await mkdir(path.join(agentDir, "agents"), { recursive: true });
	await writeFile(path.join(cwd, "sample.ts"), "export const value = 1;\n");
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "opi-fixture", defaultModel: "test", defaultThinkingLevel: "off",
		defaultTools: [], quietStartup: true, tuiMode: "fullscreen",
		compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "opi-fixture": {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture-key",
		models: [{ id: "test", name: "Fixture", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
	await writeFile(path.join(agentDir, "agents", "scout.md"), "---\nname: scout\ndescription: Read a source file\ntools: read\n---\nInspect the assigned file.\n");
});

afterEach(async () => { await server?.close(); });

async function run(args: string[], input = "") {
	const pending = exec(cli, args, { cwd, env, timeout: 25_000, maxBuffer: 8 * 1024 * 1024 });
	pending.child.stdin?.end(input);
	return pending;
}

async function runJson(args: string[] = []) {
	const result = await run(["--mode", "json", "--offline", "--approve", "--no-session", ...args, "Run the fixture"]);
	expect(result.stderr).toBe("");
	return result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function toolResults(events: Record<string, unknown>[]) {
	return events.flatMap((event) => {
		const message = event["message"];
		return event["type"] === "message_end" && typeof message === "object" && message !== null
			&& "role" in message && message.role === "toolResult" ? [message as Record<string, unknown>] : [];
	});
}

function sequence(responses: ModelResponse[]): void {
	respond = (request) => responses[request.messages.filter((message) => message.role === "tool").length]
		?? { text: "completed" };
}

function expectFullscreenImageOrder(output: string): void {
	const start = output.indexOf("\x1b[?1049h");
	const end = output.indexOf("\x1b[?1049l", start);
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	// Pi 退出时切回普通模式并回放记录。这里只检查实际全屏区间。
	const frames = [...output.slice(start, end).matchAll(/\x1b\[\?2026h([\s\S]*?)\x1b\[\?2026l/g)]
		.map((match) => match[1] ?? "")
		.filter((frame) => /\x1b_Ga=(?:T|p),/.test(frame));
	expect(frames.length).toBeGreaterThan(0);
	for (const frame of frames) {
		const imageStart = frame.search(/\x1b_Ga=(?:T|p),/);
		expect(/\x1b\[(?:[012]?K|[23]J)/.test(frame.slice(imageStart))).toBe(false);
	}
}

describe("standalone opi CLI", () => {
	it.each([["--version"], ["--help", "-ne"], ["--thinking", "invalid"], ["--session-id", "invalid"]])("保留 Pi 的参数和输出: %j", async (...args) => {
		const original = exec(process.execPath, [piCli, ...args], { cwd, env, timeout: 15_000 });
		original.child.stdin?.end();
		const capture = async (promise: Promise<{ stdout: string | Buffer; stderr: string | Buffer }>) => promise.then(
			(result) => ({ stdout: result.stdout, stderr: result.stderr, code: 0 }),
			(error: { stdout: string; stderr: string; code: number }) => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }),
		);
		expect(await capture(run(args))).toEqual(await capture(original));
	});

	it.each([undefined, "on", "only"])("codemode 启用后只声明脚本入口和 model-only 工具，忽略 mode=%s", async (mode) => {
		const settingsPath = path.join(agentDir, "settings.json");
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		await writeFile(settingsPath, JSON.stringify({ ...settings, ...(mode ? { codemode: { mode } } : {}) }));
		await runJson(["--tools", "read,bash,skill,subagent,codemode"]);
		expect(server.requests[0]?.tools?.map((tool) => tool.function.name).sort()).toEqual(["codemode", "skill", "subagent"]);
	});

	it("codemode 使用精简契约和稳定发现说明，不附带未使用的完整 MCP 类型", async () => {
		await runJson(["--tools", "read,find,bash,codemode"]);
		const request = server.requests[0];
		const definition = request?.tools?.find((tool) => tool.function.name === "codemode");
		const description = definition?.function.description ?? "";
		const system = request?.messages.filter((message) => message.role === "system" || message.role === "developer");
		console.info("codemode prompt fixture (estimated tokens)", {
			definition: countTextTokensSync(JSON.stringify(definition)).tokens,
			system: countTextTokensSync(JSON.stringify(system)).tokens,
		});
		expect(description).toContain("read(args:");
		expect(description).toContain("find(args:");
		expect(description).toContain("bash(args:");
		expect(description).toContain("exit_code");
		expect(description).toContain("searchTools");
		expect(description).toContain("describeNamespace");
		for (const omitted of ["Model API", "models.", "ALL_TOOLS", "describeTool", "ImageContent", "console.", "exit()"]) {
			expect(description).not.toContain(omitted);
		}
	});

	it("codemode 目录预算为零时仍可发现签名并调用未展示工具", async () => {
		const settingsPath = path.join(agentDir, "settings.json");
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		await writeFile(settingsPath, JSON.stringify({ ...settings, codemode: { inlineBudget: 0 } }));
		sequence([
			{ tool: "codemode", args: { code: 'text(await searchTools("Read one text image PDF file", {limit:1}));' } },
			{ tool: "codemode", args: { code: 'text(await tools.read({path:"sample.ts"}));' } },
		]);
		const results = toolResults(await runJson(["--tools", "read,codemode"]));
		const description = server.requests[0]?.tools?.find((tool) => tool.function.name === "codemode")?.function.description;
		expect(description).toContain("searchTools");
		expect(description).not.toContain("read(args:");
		expect(description).not.toContain("ImageContent");
		expect(results.every((result) => result.isError === false)).toBe(true);
		expect(JSON.stringify(results[0]?.content)).toContain("read(args:");
		expect(JSON.stringify(results[1]?.content)).toContain("export const value = 1");
	});

	it("codemode 关闭模型 API，跨调用存储只提交成功脚本的写入", async () => {
		sequence([
			{ tool: "codemode", args: { code: 'const r = await tools.find({query:"sample"}); store("files", r.matches); text(typeof models);' } },
			{ tool: "codemode", args: { code: 'store("files", []); text("partial"); throw new Error("discard writes");' } },
			{ tool: "codemode", args: { code: 'text(await tools.read({path:load("files")[0].path})); store("files", undefined);' } },
			{ tool: "codemode", args: { code: 'return load("files") === undefined;' } },
		]);
		const results = toolResults(await runJson(["--tools", "find,read,codemode"]));
		expect(results).toHaveLength(4);
		expect(JSON.stringify(results[0]?.content)).toContain("undefined");
		expect(results[1]?.isError).toBe(true);
		expect(JSON.stringify(results[1]?.content)).toContain("partial");
		expect(results[2]?.isError).toBe(false);
		expect(JSON.stringify(results[2]?.content)).toContain("export const value = 1");
		expect(JSON.stringify(results[3]?.content)).toContain("true");
	});

	it("codemode 在独立二进制中执行，嵌套 Bash 后可继续编辑且保留调用记录", async () => {
		sequence([
			{ tool: "codemode", args: { code: 'text(await tools.read({path: "sample.ts"}));' } },
			{ tool: "codemode", args: { code: `await Promise.all([
				tools.bash({command: "printf 'one\\\\n' > sample.ts"}),
				tools.bash({command: "sleep 0.2; printf 'two\\\\n' > sample.ts"})
			]); text("nested done");` } },
			{ tool: "codemode", args: { code: 'text(await tools.edit({path: "sample.ts", edits: [{old: "two", new: "three"}]}));' } },
		]);
		const events = await runJson(["--tools", "read,bash,edit,codemode"]);
		const results = toolResults(events);
		expect(results).toHaveLength(3);
		expect(results.every((result) => result.isError === false)).toBe(true);
		expect(results[1]).toMatchObject({ nestedCalls: { complete: true, calls: [{ name: "bash", status: "ok" }, { name: "bash", status: "ok" }] } });
		expect(events.filter((event) => event.type === "tool_execution_start" && event.parentToolCallId)).toHaveLength(4);
		expect(await readFile(path.join(cwd, "sample.ts"), "utf8")).toBe("three\n");
	});

	it("codemode 超时取消嵌套命令，释放文件观察窗口后可继续编辑", async () => {
		sequence([
			{ tool: "codemode", args: { code: 'text(await tools.read({path: "sample.ts"}));' } },
			{ tool: "codemode", args: { code: '// @options: {"timeout_ms": 1000}\nawait tools.bash({command: "printf changed > sample.ts; sleep 10"});' } },
			{ tool: "codemode", args: { code: 'text(await tools.edit({path: "sample.ts", edits: [{old: "changed", new: "after-abort"}]}));' } },
		]);
		const events = await runJson(["--tools", "read,bash,edit,codemode"]);
		const results = toolResults(events);
		expect(results[1]?.isError).toBe(true);
		expect(results[2]?.isError).toBe(false);
		expect(events.find((event) => event.type === "tool_execution_end" && event.toolName === "bash")).toMatchObject({ isError: true });
		expect(await readFile(path.join(cwd, "sample.ts"), "utf8")).toBe("after-abort");
	});

	it("codemode 嵌套调用仍执行审批，并拒绝调用仅向模型开放的工具", async () => {
		sequence([{ tool: "codemode", args: { code: `
			const blocked = await Promise.allSettled([tools.bash({command: "sudo true"})]);
			text(blocked[0].status);
			text(typeof tools.skill);
			text(typeof tools.subagent);
		` } }]);
		const events = await runJson(["--tools", "bash,skill,subagent,codemode"]);
		expect(JSON.stringify(toolResults(events))).toContain("rejected");
		expect(JSON.stringify(toolResults(events))).toContain("undefined");
		expect(events.find((event) => event.type === "tool_execution_end" && event.toolName === "bash")).toMatchObject({ isError: true });
	});

	it("codemode 用结构化搜索完成依赖读取，减少模型往返和中间输出", async () => {
		for (let i = 0; i < 50; i++) await writeFile(path.join(cwd, `sample-unused-${i}.ts`), "unused\n");
		sequence([{ tool: "find", args: { query: "sample", glob: "*.ts" } }, { tool: "read", args: { path: "sample.ts" } }]);
		await runJson(["--tools", "find,read"]);
		const direct = [...server.requests];
		sequence([{ tool: "codemode", args: { code: `
			const found = await tools.find({query: "sample", glob: "*.ts"});
			const target = found.matches.find(m => m.path === "sample.ts");
			text(await tools.read({path: target.path}));
		` } }]);
		const events = await runJson(["--tools", "find,read,codemode"]);
		const scripted = server.requests.slice(direct.length);
		expect(toolResults(events)[0]?.isError).toBe(false);
		expect(JSON.stringify(scripted.at(-1)?.messages)).toContain("export const value = 1");
		const measure = (requests: ModelRequest[]) => ({
			requests: requests.length,
			toolOutputTokens: countTextTokensSync(JSON.stringify(requests.at(-1)?.messages.filter((message) => message.role === "tool"))).tokens,
			requestTokens: requests.reduce((sum, request) => sum + countTextTokensSync(JSON.stringify(request)).tokens, 0),
		});
		const baseline = measure(direct), codemode = measure(scripted);
		expect(codemode.requests).toBe(2);
		expect(baseline.requests).toBe(3);
		expect(codemode.toolOutputTokens).toBeLessThan(baseline.toolOutputTokens);
		console.info("codemode fixture (estimated tokens)", { baseline, codemode });
	});

	it("codemode 的 grep 和 Bash 返回结构化数据，非零退出码仍可读取", async () => {
		sequence([{ tool: "codemode", args: { code: `
			const found = await tools.grep({query: "value", path: ["sample.ts"]});
			text(found.regions.map(r => ({path:r.path, line:r.start_line})));
			const failed = await tools.bash({command: "printf payload; exit 3"});
			text({output:failed.output, exit_code:failed.exit_code});
		` } }]);
		const events = await runJson(["--tools", "grep,bash,codemode"]);
		const results = toolResults(events);
		expect(results[0]?.isError).toBe(false);
		expect(JSON.stringify(results)).toContain("payload");
		expect(JSON.stringify(results)).toContain("sample.ts");
		expect(results[0]).toMatchObject({ nestedCalls: { calls: [{ name: "grep", status: "ok" }, { name: "bash", status: "error" }] } });
	});

	it("JSON 工具回路覆盖读写、WASM 解析 worker 和 Bash", async () => {
		await writeFile(path.join(cwd, "large.ts"), "export const valueInWorker = 3;\n" + "// worker input\n".repeat(20_000));
		sequence([
			{ tool: "ls", args: { path: "." } }, { tool: "find", args: { query: "sample" } },
			{ tool: "read", args: { path: "sample.ts" } }, { tool: "grep", args: { query: "value", path: ["sample.ts", "large.ts"] } },
			{ tool: "edit", args: { path: "sample.ts", edits: [{ old: "value = 1", new: "value = 2" }] } },
			{ tool: "write", args: { path: "created.txt", content: "written by opi\n" } },
			{ tool: "bash", args: { command: "printf opi-bash" } },
		]);
		const results = toolResults(await runJson());
		expect(results.map((result) => result["toolName"])).toEqual(["ls", "find", "read", "grep", "edit", "write", "bash"]);
		expect(results.every((result) => !result["isError"]), JSON.stringify(results)).toBe(true);
		expect(JSON.stringify(results.at(-1))).toContain("opi-bash");
		expect(await readFile(path.join(cwd, "sample.ts"), "utf8")).toContain("value = 2");
		expect(await readFile(path.join(cwd, "created.txt"), "utf8")).toBe("written by opi\n");
	});

	it("PDF 文字和页面渲染使用内嵌资源及原生 Canvas", async () => {
		await copyFile(path.resolve("tests/harness/file-tools/fixtures/read/two-page.pdf"), path.join(cwd, "sample.pdf"));
		sequence([{ tool: "read", args: { path: "sample.pdf", pages: "1" } }]);
		const results = toolResults(await runJson());
		expect(results).toHaveLength(1);
		expect(results[0]?.["isError"], JSON.stringify(results)).toBe(false);
		expect(JSON.stringify(results)).toContain('"image"');
	});

	it.each([
		{ fork: false, source: false },
		{ fork: true, source: false },
		{ fork: false, source: true },
		{ fork: true, source: true },
	])("子代理使用原配置，fork=$fork source=$source", async ({ fork, source }) => {
		await writeFile(path.join(agentDir, "agents", "scout.md"), `---\nname: scout\ndescription: Read a file\ntools: read\nfork: ${fork}\n---\nInspect the file.\n`);
		respond = (request) => {
			const parent = !request.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Read sample.ts"));
			if (request.messages.some((message) => message.role === "tool")) return { text: JSON.stringify(request.messages) };
			return parent ? { tool: "subagent", args: { tasks: [{ agent: "scout", task: "Read sample.ts" }] } }
				: { tool: "read", args: { path: "sample.ts" } };
		};
		let events: Record<string, unknown>[];
		if (source) {
			const child = exec("bun", [path.resolve("src/tui/main.ts"), "--mode", "json", "-p", "--offline", "--approve", "--no-session", "--tools", "read,subagent", "Run the fixture"], { cwd, env, timeout: 25_000, maxBuffer: 8 * 1024 * 1024 });
			child.child.stdin?.end();
			const { stdout, stderr } = await child;
			expect(stderr).toBe("");
			events = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		} else {
			events = await runJson(["--tools", "read,subagent"]);
		}
		const results = toolResults(events);
		expect(results).toHaveLength(1);
		expect(results[0], JSON.stringify(results)).toMatchObject({ toolName: "subagent", isError: false });
		expect(JSON.stringify(results)).toContain("value = 1");
	});

	it("fork 继承父请求中未持久化的强制提示词，不能只靠会话历史恢复", async () => {
		const forcedPrompt = "EXACT_PARENT_OVERRIDE\n保留换行与 Unicode。\n";
		const extension = path.join(temp.path, "force-parent.ts");
		await writeFile(extension, `export default (pi) => {
			pi.on("before_agent_start", () => process.env.PI_SUBAGENT_CHILD === "1"
				? undefined : { systemPrompt: ${JSON.stringify(forcedPrompt)} });
		};`);
		await writeFile(path.join(agentDir, "agents", "scout.md"), "---\nname: scout\ndescription: Inspect\nfork: true\n---\nInspect only the assigned scope.\n");
		const childRequest = (request: ModelRequest) => request.messages.some((message) =>
			message.role === "user" && JSON.stringify(message.content).includes("FORK_ONLY_MARKER"));
		respond = (request) => childRequest(request) || request.messages.some((message) => message.role === "tool")
			? { text: "done" }
			: { tool: "subagent", args: { tasks: [{ agent: "scout", task: "FORK_ONLY_MARKER" }] } };
		const sessionFile = path.join(temp.path, "parent.jsonl");
		const result = await run(["--mode", "json", "-p", "--offline", "--approve", "--session", sessionFile,
			"-e", extension, "--tools", "read,subagent", "Run the fixture"]);
		expect(result.stderr).toBe("");
		const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(toolResults(events)).toEqual([expect.objectContaining({ toolName: "subagent", isError: false })]);
		expect(server.requests[0]?.messages[0]?.content).toBe(forcedPrompt);
		expect(server.requests.find(childRequest)?.messages[0]?.content).toBe(forcedPrompt);
		const entries = parseSessionEntries(await readFile(sessionFile, "utf8")).filter((entry) => entry.type !== "session");
		expect(getCurrentSystemPrompt(buildSessionContext(entries).messages)).not.toContain("EXACT_PARENT_OVERRIDE");
	});

	it("保留 stdin、@file、提示词参数和模板", async () => {
		const prompt = path.join(temp.path, "review.md");
		await writeFile(prompt, "Review $1\n");
		const result = await run(["--offline", "--approve", "--no-session", "-p", "--prompt-template", prompt,
			"--system-prompt", "Custom role marker.", "--append-system-prompt", "Appended marker.", "@sample.ts", "cli marker"], "stdin marker\n");
		for (const marker of ["Custom role marker.", "Appended marker.", "value = 1", "cli marker", "stdin marker"]) expect(result.stdout).toContain(marker);
		const template = await run(["--offline", "--approve", "--no-session", "-p", "--prompt-template", prompt, "/review file"]);
		expect(template.stdout).toContain("Review file");
	});

	it.each(["global", "cli"])("独立二进制加载外部 TS 扩展及其依赖: %s", async (source) => {
		const directory = source === "global" ? path.join(agentDir, "extensions") : path.join(temp.path, "plugin");
		await mkdir(directory, { recursive: true });
		await mkdir(path.join(directory, "node_modules", "fixture-dependency"), { recursive: true });
		await writeFile(path.join(directory, "node_modules", "fixture-dependency", "package.json"),
			JSON.stringify({ name: "fixture-dependency", main: "index.cjs" }));
		await writeFile(path.join(directory, "node_modules", "fixture-dependency", "index.cjs"), "exports.value = 'external-dependency-ok';");
		const extension = path.join(directory, "external 中文 空格 #100%.ts");
		await writeFile(extension, `
			import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
			import { Type } from 'typebox';
			import { truncateHead } from '@earendil-works/pi-coding-agent';
			import { value } from 'fixture-dependency';
			export default (pi: ExtensionAPI) => pi.registerTool({
				name: 'external_fixture', label: 'Fixture', description: 'External fixture',
				parameters: Type.Object({}),
				async execute() { return { content: [{ type: 'text', text: truncateHead(value).content }], details: {} }; }
			});
		`);
		const flags = source === "cli" ? ["-e", extension] : [];
		env["PATH"] = path.join(temp.path, "empty-bin");
		sequence([{ tool: "external_fixture", args: {} }]);
		const results = toolResults(await runJson([...flags, "--tools", "external_fixture", "--"]));
		expect(results).toHaveLength(1);
		expect(results[0]?.["isError"], JSON.stringify(results)).toBe(false);
		expect(JSON.stringify(results)).toContain("external-dependency-ok");
	});

	it("-ne 禁用自动发现和静态扩展，但保留显式 -e", async () => {
		await mkdir(path.join(agentDir, "extensions"));
		const marker = path.join(temp.path, "external-executed");
		const extension = path.join(agentDir, "extensions", "external.js");
		await writeFile(extension, `import {writeFileSync} from 'node:fs'; export default () => writeFileSync(${JSON.stringify(marker)}, 'loaded');`);
		await run(["--offline", "--approve", "--no-session", "-ne", "-p", "--", "message"]);
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
		await run(["--offline", "--approve", "--no-session", "-ne", "-e", extension, "-p", "message"]);
		expect(await readFile(marker, "utf8")).toBe("loaded");
	});

	it("未信任项目时不执行项目扩展", async () => {
		const directory = path.join(cwd, ".pi", "extensions");
		await mkdir(directory, { recursive: true });
		const marker = path.join(temp.path, "untrusted-executed");
		await writeFile(path.join(directory, "external.ts"), `import {writeFileSync} from 'node:fs'; export default () => writeFileSync(${JSON.stringify(marker)}, 'bad');`);
		await run(["--offline", "--no-approve", "--no-session", "-p", "message"]);
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("外部扩展初始化失败时报告错误", async () => {
		const extension = path.join(temp.path, "broken.ts");
		await writeFile(extension, "export default () => { throw new Error('external-fixture-failed'); };");
		await expect(run(["--offline", "--approve", "--no-session", "-e", extension, "-p", "message"]))
			.rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("external-fixture-failed") });
	});

	it("并发首次启动原子发布同一个完整资源目录", async () => {
		const results = await Promise.allSettled(Array.from({ length: 4 }, () => run(["--help"])));
		for (const result of results) if (result.status === "rejected") throw result.reason;
		const directories = await readdir(path.join(temp.path, ".pi", "cache", "opi"));
		expect(directories).toHaveLength(1);
		expect(directories[0]).toMatch(/^[a-f0-9]{64}$/);
	});

	it.skipIf(process.platform !== "linux")("真实终端从无外部扩展启动，/reload 加载新增扩展", async () => {
		const directory = path.join(agentDir, "extensions");
		await mkdir(directory);
		const pending = exec("/usr/bin/script", ["-qfec", `stty cols 100 rows 35; exec '${cli}' --offline --approve`, "/dev/null"], {
			cwd, env: { ...env, PI_TIMING: "1" }, timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
		});
		let output = "";
		let requestedReload = false;
		let requestedProbe = false;
		let requestedExit = false;
		pending.child.stdout?.on("data", (chunk) => {
			output += String(chunk);
			if (!requestedReload && output.includes("NEW SESSION")) {
				requestedReload = true;
				writeFileSync(path.join(directory, "added.ts"), `
					import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
					export default (pi: ExtensionAPI) => pi.registerCommand('probe-reloaded', {
						handler: async (_args, ctx) => ctx.ui.notify('external-reloaded-marker', 'info')
					});
				`);
				pending.child.stdin?.write("/reload\r");
			}
			if (!requestedProbe && output.includes("Reloaded keybindings")) {
				requestedProbe = true;
				pending.child.stdin?.write("/probe-reloaded\r");
			}
			if (!requestedExit && output.includes("external-reloaded-marker")) {
				requestedExit = true;
				setTimeout(() => pending.child.stdin?.write("\u0004"), 100);
			}
		});
		const result = await pending.catch((error: unknown) => {
			throw new Error(`Reload probe: requested=${requestedReload}, exited=${requestedExit}, output=${JSON.stringify(output.slice(0, 1500))}: ${String(error)}`);
		});
		expect(result.stdout).toContain("external-reloaded-marker");
		expect(result.stderr).toBe("");
	}, 25_000);

	it.skipIf(process.platform !== "linux")("独立二进制在图片终端渲染公式，无动态字体加载错误", async () => {
		respond = () => ({ text: "$$\n" + String.raw`\mathbb{R} \ni x = \frac{\alpha^2}{\sqrt{y}}` + "\n$$" });
		const pending = exec("/usr/bin/script", ["-qfec", `stty cols 120 rows 40; exec '${cli}' --offline --approve --no-session 'Render math'`, "/dev/null"], {
			cwd, env: { ...env, TERM_PROGRAM: "kitty" }, timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
		});
		let output = "";
		let requestedExit = false;
		pending.child.stdout?.on("data", (chunk) => {
			output += String(chunk);
			if (!requestedExit && (output.includes("iVBORw0KGgo") || output.includes("Cannot find module") || output.includes("initialization failed"))) {
				requestedExit = true;
				setTimeout(() => pending.child.stdin?.write("\u0004"), 200);
			}
		});
		const result = await pending;
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("\u001b_G");
		expect(result.stdout).toContain("iVBORw0KGgo");
	}, 25_000);

	it.skipIf(process.platform !== "linux")("Pi 交互宿主读取多行图片，完整帧先清行再绘图", async () => {
		const canvas = createCanvas(180, 180);
		const context = canvas.getContext("2d");
		context.fillStyle = "#ff6060";
		context.fillRect(0, 0, 180, 90);
		context.fillStyle = "#6060ff";
		context.fillRect(0, 90, 180, 90);
		await writeFile(path.join(cwd, "picture.png"), canvas.toBuffer("image/png"));
		sequence([{ tool: "read", args: { path: "picture.png" } }, { text: "Image read completed." }]);
		const pending = exec("/usr/bin/script", ["-qfec", `stty cols 100 rows 35; exec '${cli}' --offline --approve --no-session 'Read image'`, "/dev/null"], {
			cwd, env: { ...env, TERM_PROGRAM: "wezterm" }, timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
		});
		let output = "";
		let requestedExit = false;
		pending.child.stdout?.on("data", (chunk) => {
			output += String(chunk);
			if (!requestedExit && output.includes("iVBORw0KGgo")) {
				requestedExit = true;
				setTimeout(() => pending.child.stdin?.write("\u0004"), 200);
			}
		});
		const result = await pending;
		expect(result.stderr).toBe("");
		expectFullscreenImageOrder(result.stdout);
		const rows = [...result.stdout.matchAll(/\x1b_G[^;\x1b]*,r=(\d+)/g)].map((match) => Number(match[1]));
		expect(rows.some((count) => count > 1)).toBe(true);
		expect(result.stdout).toContain("\x1b[?1006l");
		expect(result.stdout).toContain("\x1b[?1049l");
	}, 25_000);

	it.skipIf(process.platform !== "linux").each(["regular", "fullscreen"])("独立 TUI 宿主保留扩展 UI，并在 /new 后重新绑定：%s", async (mode) => {
		const extension = path.join(temp.path, "ui-probe.ts");
		await writeFile(extension, `
			export default (pi) => {
				pi.on("session_start", (event, ctx) => {
					ctx.ui.notify(event.reason === "new" ? "REBOUND-MARKER" : "READY-MARKER");
				});
				pi.registerCommand("ui-probe", {
					async handler(_args, ctx) {
						const selected = await ctx.ui.select("SELECT-MARKER", ["first", "second"]);
						const input = await ctx.ui.input("INPUT-MARKER");
						const custom = await ctx.ui.custom((_tui, _theme, _keys, done) => ({
							render: () => ["CUSTOM-MARKER"], invalidate() {},
							handleInput(data) { if (data === "x") done("custom"); },
						}), { overlay: true });
						const confirmed = await ctx.ui.confirm("CONFIRM-MARKER", "Continue?");
						ctx.ui.notify("PROBE-DONE:" + [selected, input, custom, confirmed].join(":"));
					}
				});
			};
		`);
		const pending = exec("/usr/bin/script", ["-qfec", `stty cols 120 rows 40; exec '${cli}' --offline --approve -ne --tui-mode ${mode} -e '${extension}'`, "/dev/null"], {
			cwd, env: { ...env, PI_TIMING: "1" }, timeout: 25_000, maxBuffer: 4 * 1024 * 1024,
		});
		const interactions = [
			["SELECT-MARKER", "\r"], ["INPUT-MARKER", "answer\r"],
			["CUSTOM-MARKER", "x"], ["CONFIRM-MARKER", "\r"],
		] as const;
		const steps = [
			["READY-MARKER", "/ui-probe\r"], ...interactions,
			["PROBE-DONE:first:answer:custom:true", "/new\r"],
			["REBOUND-MARKER", "/ui-probe\r"], ...interactions,
			["PROBE-DONE:first:answer:custom:true", "\u0004"],
		] as const;
		let output = "";
		let offset = 0;
		let step = 0;
		pending.child.stdout?.on("data", (chunk) => {
			output += String(chunk);
			const current = steps[step];
			if (current === undefined) return;
			const index = output.indexOf(current[0], offset);
			if (index === -1) return;
			offset = index + current[0].length;
			step += 1;
			setTimeout(() => pending.child.stdin?.write(current[1]), 60);
		});
		const result = await pending.catch((error: unknown) => {
			throw new Error(`PTY stopped at step ${step}/${steps.length}: ${JSON.stringify(output.slice(-5000))}`, { cause: error });
		});
		expect(step).toBe(steps.length);
		expect(result.stderr).toBe("");
		if (mode === "fullscreen") expect(result.stdout).toContain("\x1b[?1049l");
	}, 30_000);

	it.each(["install", "remove", "uninstall", "update", "list", "config"])("拒绝不支持的包命令 %s", async (command) => {
		await expect(run([command])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Pi packages") });
	});
});
