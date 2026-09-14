import { VERSION } from "@earendil-works/pi-coding-agent";
import { createCanvas } from "@napi-rs/canvas";
import { execFile } from "node:child_process";
import { constants, writeFileSync } from "node:fs";
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
		await copyFile(path.resolve("tests/harness/file-tools/fixtures/read/two-page.pdf"), path.join(cwd, "sample.pdf"));
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

	it("版本命令不依赖 PATH 中的 Node/Bun，也不读取当前目录的 .env", async () => {
		env["PATH"] = path.join(temp.path, "empty-bin");
		await writeFile(path.join(cwd, ".env"), "PI_PACKAGE_DIR=/missing-from-dotenv\n");
		const result = await run(["--version"]);
		expect(result.stderr).toBe("");
		expect(result.stdout.trim()).toBe(VERSION);
	});

	it("并发首次启动原子发布同一个完整资源目录", async () => {
		const results = await Promise.allSettled(Array.from({ length: 4 }, () => run(["--version"])));
		for (const result of results) {
			if (result.status === "rejected") throw result.reason;
			expect(result.value.stdout.trim()).toBe(VERSION);
		}
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
		let requestedExit = false;
		pending.child.stdout?.on("data", (chunk) => {
			output += String(chunk);
			if (!requestedReload && output.includes("NEW SESSION")) {
				requestedReload = true;
				writeFileSync(path.join(directory, "added.ts"), `
					import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
					export default (pi: ExtensionAPI) => pi.on('session_start', (_event, ctx) => {
						ctx.ui.notify('external-reloaded-marker', 'info');
					});
				`);
				pending.child.stdin?.write("/reload\r");
			}
			if (!requestedExit && output.includes("external-reloaded-marker")) {
				requestedExit = true;
				setTimeout(() => pending.child.stdin?.write("\u0004"), 100);
			}
		});
		const result = await pending;
		expect(result.stdout).toContain("external-reloaded-marker");
		expect(result.stdout).not.toContain("Failed to load extension");
		expect(result.stderr).toBe("");
	}, 25_000);

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
		expect(result.stdout).not.toContain("initialization failed");
		if (mode === "fullscreen") expect(result.stdout).toContain("\x1b[?1049l");
	}, 30_000);

	it.each(["install", "remove", "uninstall", "update", "list", "config"])("拒绝不支持的包命令 %s", async (command) => {
		await expect(run([command])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Pi packages") });
	});
});
