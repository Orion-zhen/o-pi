import { createCanvas } from "@napi-rs/canvas";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTempDir } from "../helpers/lifecycle.js";
import { startModelServer, type ModelRequest, type ModelResponse } from "./model-server.js";

const exec = promisify(execFile);
const builtCli = path.resolve(process.platform === "win32" ? "dist/opi.exe" : "dist/opi");
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
		expect(frame.endsWith("\x1b8"), JSON.stringify({ prefix: frame.slice(0, 80), tail: frame.slice(-160) })).toBe(true);
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
		await copyFile(path.resolve("tests/file-tools/fixtures/read/two-page.pdf"), path.join(cwd, "sample.pdf"));
		sequence([{ tool: "read", args: { path: "sample.pdf", pages: "1" } }]);
		const results = toolResults(await runJson());
		expect(results).toHaveLength(1);
		expect(results[0]?.["isError"], JSON.stringify(results)).toBe(false);
		expect(JSON.stringify(results)).toContain('"image"');
	});

	it.each([false, true])("子代理重启当前 opi 并使用原配置，fork=%s", async (fork) => {
		await writeFile(path.join(agentDir, "agents", "scout.md"), `---\nname: scout\ndescription: Read a file\ntools: read\nfork: ${fork}\n---\nInspect the file.\n`);
		respond = (request) => {
			const parent = !request.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Read sample.ts"));
			if (request.messages.some((message) => message.role === "tool")) return { text: JSON.stringify(request.messages) };
			return parent ? { tool: "subagent", args: { tasks: [{ agent: "scout", task: "Read sample.ts" }] } }
				: { tool: "read", args: { path: "sample.ts" } };
		};
		const results = toolResults(await runJson(["--tools", "read,subagent"]));
		expect(results).toHaveLength(1);
		expect(results[0], JSON.stringify(results)).toMatchObject({ toolName: "subagent", isError: false });
		expect(JSON.stringify(results)).toContain("value = 1");
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

	it("不执行自动发现的外部扩展，-- 分隔符不绕过限制", async () => {
		await mkdir(path.join(agentDir, "extensions"));
		const marker = path.join(temp.path, "external-executed");
		const extension = path.join(agentDir, "extensions", "external.ts");
		await writeFile(extension, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export default () => {};`);
		await run(["--offline", "--approve", "--no-session", "-p", "--", "message"]);
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(run(["-e", extension, "--version"])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("external extensions") });
	});

	it("版本命令不依赖 PATH 中的 Node/Bun，也不读取当前目录的 .env", async () => {
		env["PATH"] = path.join(temp.path, "empty-bin");
		await writeFile(path.join(cwd, ".env"), "PI_PACKAGE_DIR=/missing-from-dotenv\n");
		const result = await run(["--version"]);
		expect(result.stderr).toBe("");
		expect(result.stdout.trim()).toBe("0.85.1");
	});

	it("并发首次启动原子发布同一个完整资源目录", async () => {
		const results = await Promise.all(Array.from({ length: 4 }, () => run(["--version"])));
		expect(results.every((result) => result.stdout.trim() === "0.85.1")).toBe(true);
		const directories = await readdir(path.join(temp.path, ".pi", "cache", "opi"));
		expect(directories).toHaveLength(1);
		expect(directories[0]).toMatch(/^[a-f0-9]{64}$/);
	});

	it.skipIf(process.platform !== "linux")("真实终端启动 Pi TUI 和静态界面增强", async () => {
		const pending = exec("/usr/bin/script", ["-qfec", `stty cols 100 rows 35; exec '${cli}' --offline --approve`, "/dev/null"], {
			cwd, env: { ...env, PI_TIMING: "1" }, timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
		});
		let output = "";
		let requestedExit = false;
		pending.child.stdout?.on("data", (chunk) => {
			output += String(chunk);
			if (!requestedExit && output.includes("Startup Timings: main")) {
				requestedExit = true;
				setTimeout(() => pending.child.stdin?.write("\u0004"), 100);
			}
		});
		const result = await pending;
		expect(result.stdout).toContain("Startup Timings: main");
		expect(result.stdout).not.toContain("initialization failed");
		expect(result.stdout).not.toContain("Failed to load extension");
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
		expect(result.stdout).not.toContain("Cannot find module");
		expect(result.stdout).not.toContain("initialization failed");
		expect(result.stdout).toContain("\u001b_G");
		expect(result.stdout).toContain("iVBORw0KGgo");
		expectFullscreenImageOrder(result.stdout);
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
		expect(result.stdout).not.toContain("initialization failed");
		expectFullscreenImageOrder(result.stdout);
		const rows = [...result.stdout.matchAll(/\x1b_G[^;\x1b]*,r=(\d+)/g)].map((match) => Number(match[1]));
		expect(rows.some((count) => count > 1)).toBe(true);
		expect(result.stdout).toContain("\x1b[?1006l");
		expect(result.stdout).toContain("\x1b[?1049l");
	}, 25_000);

	it.each(["install", "remove", "uninstall", "update", "list", "config"])("拒绝不支持的包命令 %s", async (command) => {
		await expect(run([command])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Pi packages") });
	});
});
