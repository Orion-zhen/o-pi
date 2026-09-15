import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GuiHost } from "../../src/gui/host/host.ts";
import type { GuiEvent } from "../../src/gui/contract.ts";
import { startModelServer } from "../cli/model-server.ts";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.ts";

const temp = useTempDir("opi-gui-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_OFFLINE");
let host: GuiHost;
let server: Awaited<ReturnType<typeof startModelServer>>;
let cwd: string;
let events: GuiEvent[];

beforeEach(async () => {
	setTestHome(temp.path);
	cwd = await mkdtemp(path.join(process.cwd(), ".gui-test-"));
	const agentDir = path.join(temp.path, ".pi", "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	await mkdir(path.join(agentDir, "configs"), { recursive: true });
	await mkdir(cwd, { recursive: true });
	server = await startModelServer((request) => {
		const tools = request.messages.filter((message) => message.role === "tool").length;
		if (tools === 0) return { tool: "read", args: { path: "input.txt" } };
		if (tools === 1) return { tool: "write", args: { path: "output.txt", content: "GUI SDK result\n" } };
		return { text: "GUI completed" };
	});
	await writeFile(path.join(cwd, "input.txt"), "input\n");
	await writeFile(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProjectTrust: "never",
			defaultProvider: "gui-fixture",
			defaultModel: "test",
			defaultThinkingLevel: "off",
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	);
	await writeFile(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"gui-fixture": {
					baseUrl: server.url,
					api: "openai-completions",
					apiKey: "private-fixture-secret",
					models: [
						{
							id: "test",
							name: "Test",
							reasoning: false,
							input: ["text"],
							contextWindow: 128000,
							maxTokens: 4096,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
	host = new GuiHost();
	events = [];
	host.subscribe((event) => events.push(event));
	await host.start(cwd);
});
afterEach(async () => {
	await host?.dispose();
	await server?.close();
	await rm(cwd, { recursive: true, force: true });
});

const prompt = (text: string) => ({ action: "prompt", text, images: [], behavior: "followUp" });

describe("GUI 直接使用 SDK", () => {
	it("真实文件工具回路、会话恢复和结构化面板，不启动 CLI 或 RPC", async () => {
		await host.dispatch(prompt("Read input, write output"));
		expect(await readFile(path.join(cwd, "output.txt"), "utf8")).toBe("GUI SDK result\n");
		expect(JSON.stringify(host.snapshot().messages)).toContain("GUI completed");
		expect(JSON.stringify(host.snapshot())).not.toContain("private-fixture-secret");
		const file = host.snapshot().sessionFile;
		expect(file).not.toBeNull();
		for (const command of ["/stats", "/system", "/tools", "/usage", "/telemetry"]) await host.dispatch(prompt(command));
		expect(events.filter((event) => event.type === "panel").map((event) => event.title)).toEqual(
			expect.arrayContaining(["会话统计", "系统提示词", "工具选择", "套餐用量", "遥测"]),
		);
		await host.dispatch({ action: "tool", name: "websearch", enabled: false });
		expect(host.snapshot().tools.find((tool) => tool.name === "websearch")?.enabled).toBe(false);
		await host.dispatch({ action: "new" });
		expect(host.snapshot().messages).toHaveLength(0);
		await host.dispatch({ action: "switch", path: file });
		expect(JSON.stringify(host.snapshot().messages)).toContain("GUI completed");
		expect(host.snapshot().tools.find((tool) => tool.name === "websearch")?.enabled).toBe(false);
	});

	it("审批在界面重连后仍存在，拒绝不写文件，旧响应不可再次消费", async () => {
		await writeFile(
			path.join(temp.path, ".pi", "agent", "configs", "approval-gate.jsonc"),
			'{"tools":{"write":{"default_action":"ask"}}}',
		);
		const task = host.dispatch(prompt("Write output"));
		await expect.poll(() => host.dialogs.list().length).toBe(1);
		const dialog = host.dialogs.list()[0];
		if (!dialog) throw new Error("Missing approval");
		const replay: GuiEvent[] = [];
		const unsubscribe = host.subscribe((event) => replay.push(event));
		expect(replay.some((event) => event.type === "dialogs" && event.value.some((item) => item.id === dialog.id))).toBe(
			true,
		);
		unsubscribe();
		await host.dispatch({ action: "dialog", id: dialog.id, value: null });
		await task;
		await expect(readFile(path.join(cwd, "output.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(host.dispatch({ action: "dialog", id: dialog.id, value: "Allow once" })).rejects.toThrow("已结束");
	});

	it("无效工作目录不破坏当前会话，设置编辑拒绝覆盖外部修改", async () => {
		const id = host.snapshot().sessionId;
		await expect(host.dispatch({ action: "workspace", path: path.join(cwd, "missing") })).rejects.toThrow();
		expect(host.snapshot().sessionId).toBe(id);
		await host.dispatch({ action: "config", file: "settings.json" });
		const config = events.find((event) => event.type === "config");
		if (!config || config.type !== "config") throw new Error("Missing settings");
		const file = path.join(temp.path, ".pi", "agent", "settings.json");
		await writeFile(file, `${config.content}\n`);
		await expect(
			host.dispatch({ action: "saveConfig", file: "settings.json", original: config.content, content: "{}" }),
		).rejects.toThrow("已被修改");
		expect(await readFile(file, "utf8")).toBe(`${config.content}\n`);
	});

	it("未信任的项目扩展不执行，关闭启动中的信任对话框可释放宿主", async () => {
		await host.dispose();
		const agentDir = path.join(temp.path, ".pi", "agent");
		const settingsFile = path.join(agentDir, "settings.json");
		const settings = JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>;
		settings["defaultProjectTrust"] = "ask";
		await writeFile(settingsFile, JSON.stringify(settings));
		await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
		const marker = path.join(cwd, "extension-executed.txt");
		await writeFile(
			path.join(cwd, ".pi", "extensions", "project.ts"),
			`import {writeFileSync} from 'node:fs'; export default function () { writeFileSync(${JSON.stringify(marker)}, 'executed'); }`,
		);
		host = new GuiHost();
		const start = host.start(cwd);
		await expect.poll(() => host.dialogs.list().length).toBe(1);
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
		await host.dispose();
		await start;
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("用户 Shell、JSONL 导出导入以及输入边界", async () => {
		await host.dispatch(prompt("!printf gui-shell"));
		expect(JSON.stringify(host.snapshot().messages)).toContain("gui-shell");
		await host.dispatch({ action: "export", format: "jsonl" });
		const download = events.find((event) => event.type === "download");
		if (!download || download.type !== "download") throw new Error("Missing export");
		await host.dispatch({ action: "new" });
		await host.dispatch({ action: "import", content: download.content });
		expect(JSON.stringify(host.snapshot().messages)).toContain("gui-shell");
		await expect(host.dispatch({ action: "prompt", text: "x" })).rejects.toThrow("无效");
	});
});
