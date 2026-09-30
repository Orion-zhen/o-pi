import { readSnapshot } from "./read-snapshot.ts";
import { collectSessionState } from "../../src/tui/shell/snapshot.ts";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GuiHost } from "../../src/gui/host/host.ts";
import type { GuiClient } from "../../src/gui/host/client.ts";
import type { GuiEvent } from "../../src/gui/contract.ts";
import { startModelServer, type ModelResponse } from "../cli/model-server.ts";
import { deferred } from "../helpers/async.ts";
import { storeSession } from "./session-fixture.ts";
import { assistant } from "./transcript-fixtures.ts";
import { locateTranscript } from "../../src/gui/ui/transcript-location.ts";
import { historyDeletionTests } from "./deletion-cases.ts";
import { sidebarTests } from "./sidebar-cases.ts";
import { workbenchTests } from "./workbench-cases.ts";
import { queueTests } from "./queue-cases.ts";
import { multiSessionTests } from "./multi-session-cases.ts";
import { newSessionTests } from "./new-session-cases.ts";
import { changelogTests } from "./changelog-cases.ts";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.ts";

const temp = useTempDir("opi-gui-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_GUI_CONFIG", "PI_OFFLINE");
let host: GuiClient;
let server: Awaited<ReturnType<typeof startModelServer>>;
let cwd: string;
let events: GuiEvent[];
let titleReply: () => ModelResponse | Promise<ModelResponse>;

beforeEach(async () => {
	setTestHome(temp.path);
	cwd = await mkdtemp(path.join(process.cwd(), ".gui-test-"));
	const agentDir = path.join(temp.path, ".pi", "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_GUI_CONFIG;
	process.env.PI_OFFLINE = "1";
	await mkdir(path.join(agentDir, "configs"), { recursive: true });
	await mkdir(cwd, { recursive: true });
	titleReply = () => ({ text: "检查文件并写入结果" });
	server = await startModelServer((request) => {
		if (!request.tools) return titleReply();
		const lastUser = request.messages.findLastIndex((message) => message.role === "user");
		const tools = request.messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
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
					models: ["test", "second", "third"].map((id) => ({
						id,
						name: id,
						reasoning: false,
						input: ["text"],
						contextWindow: 128000,
						maxTokens: 4096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					})),
				},
			},
		}),
	);
	await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
	await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
	host = new GuiHost().createClient();
	events = [];
	host.subscribe((event) => events.push(event));
	await host.host.start(cwd);
});
afterEach(async () => {
	await host?.host.dispose();
	await server?.close();
	await rm(cwd, { recursive: true, force: true });
});

const prompt = (text: string) => ({ action: "prompt", text, images: [], behavior: "followUp" });

historyDeletionTests(() => ({ host, cwd, agentDir: path.join(temp.path, ".pi", "agent"), events }));
sidebarTests(() => ({ host, cwd, agentDir: path.join(temp.path, ".pi", "agent"), events }));
workbenchTests(() => ({ host, cwd }));
queueTests(() => ({ host, agentDir: path.join(temp.path, ".pi", "agent") }));
multiSessionTests(() => ({ host, cwd, agentDir: path.join(temp.path, ".pi", "agent") }));
newSessionTests(() => ({ host, cwd, agentDir: path.join(temp.path, ".pi", "agent") }));
changelogTests(() => ({ host, cwd, agentDir: path.join(temp.path, ".pi", "agent") }));

describe("GUI 直接使用 SDK", () => {
	it("子代理可用状态随 profile 重载更新，选择器与实际声明一致", async () => {
		const subagent = () => readSnapshot(host).tools.find((tool) => tool.name === "subagent");
		expect(subagent()).toMatchObject({ available: false, enabled: false });
		const directory = path.join(temp.path, ".pi", "agent", "agents");
		await mkdir(directory, { recursive: true });
		const file = path.join(directory, "reviewer.md");
		await writeFile(file, "---\nname: reviewer\ndescription: Review code\ntools: read\n---\nReview the requested file.\n");
		await host.dispatch({ action: "reload" });
		expect(subagent()).toMatchObject({ available: true });
		await host.dispatch({ action: "tool", name: "subagent", enabled: true });
		expect(subagent()).toMatchObject({ available: true, enabled: true });
		expect(host.runtime.session.getActiveToolNames()).toContain("subagent");
		await rm(file);
		await host.dispatch({ action: "reload" });
		expect(subagent()).toMatchObject({ available: false, enabled: false });
		expect(host.runtime.session.getActiveToolNames()).not.toContain("subagent");
	});
	it("虚拟模型保留选择，响应模型随路由变化并在重载后恢复", async () => {
		const directory = path.join(temp.path, ".pi", "agent", "extensions");
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, "router.ts"), `export default (pi) => pi.registerVirtualModel({
			provider: "router", id: "auto", name: "Auto",
			route: (request, ctx) => ({ model: ctx.modelRegistry.find("gui-fixture", request.reason === "user" ? "test" : "second"), thinkingLevel: "off" }),
		});`);
		await host.dispatch({ action: "reload" });
		await host.dispatch({ action: "model", provider: "router", id: "auto" });
		expect(readSnapshot(host)).toMatchObject({ model: { provider: "router", id: "auto" }, routedModel: null });
		await host.dispatch(prompt("检查 input.txt 并写入 output.txt"));
		const check = () => {
			expect(readSnapshot(host)).toMatchObject({
				model: { provider: "router", id: "auto" },
				routedModel: { model: { provider: "gui-fixture", id: "second" }, thinkingLevel: "off" },
			});
			expect(collectSessionState(host.runtime.session.extensionRunner.createContext(), "ready")).toMatchObject({
				modelId: "auto", modelProvider: "router",
				routedModel: { provider: "gui-fixture", id: "second", thinkingLevel: "off" },
			});
		};
		check();
		expect(server.requests.filter((request) => request.tools).map((request) => request.model)).toEqual(["test", "second", "second"]);
		await host.dispatch({ action: "reload" });
		check();
		for (const stopReason of ["error", "aborted"] as const) {
			host.runtime.session.sessionManager.appendMessage({
				...assistant([{ type: "text", text: "未完成响应" }], stopReason), provider: "gui-fixture", model: "third",
			});
		}
		host.runtime.session.refreshContext();
		check();
		for (const entry of host.runtime.session.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant" && entry.message.model === "second")
				host.runtime.session.sessionManager.appendContextEdit(entry.id, null);
		}
		host.runtime.session.refreshContext();
		expect(readSnapshot(host).routedModel?.model.id).toBe("test");
		expect(collectSessionState(host.runtime.session.extensionRunner.createContext(), "ready").routedModel?.id).toBe("test");
		await host.dispatch({ action: "model", provider: "gui-fixture", id: "test" });
		expect(readSnapshot(host).routedModel).toBeNull();
		expect(collectSessionState(host.runtime.session.extensionRunner.createContext(), "ready")).not.toHaveProperty("routedModel");
	});

	it("上下文删除和替换不改写 GUI 历史，重载后仍能定位原始消息", async () => {
		const { session } = host.runtime;
		const manager = session.sessionManager;
		const userId = manager.appendMessage({ role: "user", content: "原始问题", timestamp: 1 });
		const replyId = manager.appendMessage(assistant([{ type: "text", text: "废弃尝试" }], "error"));
		manager.appendContextEdit(userId, { content: "模型实际问题" });
		manager.appendContextEdit(replyId, null);
		session.refreshContext();
		expect(JSON.stringify(session.messages)).toContain("模型实际问题");
		expect(JSON.stringify(session.messages)).not.toContain("废弃尝试");
		const check = () => {
			const snapshot = readSnapshot(host);
			expect(snapshot.messages).toContainEqual(expect.objectContaining({ role: "user", content: "原始问题" }));
			expect(JSON.stringify(snapshot.messages)).toContain("废弃尝试");
			expect(JSON.stringify(snapshot.messages)).not.toContain("模型实际问题");
			expect(locateTranscript(snapshot, replyId)).toMatchObject({ preview: false, entryIds: [userId, replyId] });
		};
		check();
		await host.dispatch({ action: "reload" });
		check();
	});

	it("prune 不再选择已被 SDK 从模型上下文删除的工具事务", async () => {
		await host.dispatch(prompt("检查 input.txt 并写入 output.txt"));
		const { session } = host.runtime;
		const manager = session.sessionManager;
		const before = readSnapshot(host).messages;
		for (const entry of manager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "toolResult" || (message.role === "assistant" && message.content.some((block) => block.type === "toolCall"))) {
				manager.appendContextEdit(entry.id, null);
			}
		}
		session.refreshContext();
		await host.dispatch(prompt("/prune force"));
		expect(manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "prune")).toBe(false);
		expect(readSnapshot(host).messages).toEqual(before);
	});

	it("主任务结束后生成标题仍更新共享宿主快照与会话列表", async () => {
		const reply = deferred<ModelResponse>();
		titleReply = () => reply.promise;
		await writeFile(path.join(temp.path, ".pi", "agent", "configs", "auto-title.jsonc"), '{"enabled":true}');
		await host.dispatch({ action: "reload" });
		await host.dispatch(prompt("检查 input.txt 并写入 output.txt"));
		expect(host.runtime.session.sessionName).toBeUndefined();
		reply.resolve({ text: "检查文件并写入结果" });
		await expect.poll(() => events.filter((event) => event.type === "sessions").at(-1)?.value).toContainEqual(
			expect.objectContaining({ path: host.runtime.session.sessionFile, title: "检查文件并写入结果" }),
		);
		await expect.poll(() => events.filter((event) => event.type === "snapshot").at(-1)?.value?.name).toBe("检查文件并写入结果");
	});

	it("后台命名失败只通知一次，主会话仍可继续且不重复命名", async () => {
		titleReply = () => ({ text: "" });
		await writeFile(path.join(temp.path, ".pi", "agent", "configs", "auto-title.jsonc"), '{"enabled":true}');
		await host.dispatch({ action: "reload" });
		await host.dispatch(prompt("命名失败不应影响任务"));
		await expect.poll(() => host.execution.dialogs.notices.filter((notice) => notice.text.startsWith("Auto-title:"))).toEqual([
			expect.objectContaining({ type: "warning" }),
		]);
		await host.dispatch(prompt("继续执行主任务"));
		expect(host.runtime.session.sessionName).toBeUndefined();
		expect(JSON.stringify(readSnapshot(host).messages)).toContain("GUI completed");
		expect(server.requests.filter((request) => Array.isArray(request.messages) && !request.tools)).toHaveLength(1);
		expect(host.execution.dialogs.notices.filter((notice) => notice.text.startsWith("Auto-title:"))).toHaveLength(1);
		expect(events.filter((event) => event.type === "error")).toEqual([]);
	});

	it("宿主退出取消尚未完成的后台命名，不等待命名超时", async () => {
		const reply = deferred<ModelResponse>();
		titleReply = () => reply.promise;
		await writeFile(path.join(temp.path, ".pi", "agent", "configs", "auto-title.jsonc"), '{"enabled":true}');
		await host.dispatch({ action: "reload" });
		try {
			await host.dispatch(prompt("执行后关闭宿主"));
			await host.host.dispose();
		} finally { reply.resolve({ text: "不应在退出后写入的标题" }); }
	});

	it("删除启动会话后新页面不会重新打开已删除实例", async () => {
		await host.dispatch(prompt("启动会话"));
		const file = readSnapshot(host).sessionFile;
		if (!file) throw new Error("缺少已保存的会话文件");
		await host.dispatch({ action: "deleteSession", path: file });
		const second = host.host.createClient();
		try {
			await expect.poll(() => second.selected?.id).toBe(readSnapshot(host).sessionId);
			await second.dispatch({ action: "rename", name: "新页面" });
			expect(readSnapshot(second).name).toBe("新页面");
			await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
		} finally { second.close(); }
	});

	it("任务运行期间保存 GUI 设置不重载会话或中断 Shell", async () => {
		const session = host.runtime.session;
		const running = host.dispatch(prompt("!printf 'gui-settings-started\\n'; sleep 0.3; printf 'gui-settings-finished\\n'"));
		await expect.poll(() => readSnapshot(host).canChangeSession).toBe(false);
		const config = await host.query({ query: "guiConfig" });
		await host.dispatch({ action: "saveGuiConfig", original: config.content, content: '{"theme":"dark","sessionCache":{"idleLimit":0,"idleMs":25}}' });
		expect(host.runtime.session).toBe(session);
		await running;
		expect(JSON.stringify(readSnapshot(host).messages)).toContain("gui-settings-finished");
		expect(readSnapshot(host).canChangeSession).toBe(true);
		expect(server.requests.filter((request) => Array.isArray(request.messages))).toHaveLength(0);
	});

	it("内建和扩展命令补全不执行命令或写入历史", async () => {
		const before = readSnapshot(host);
		const cases: [string, string[]][] = [
			["/lsp", ["status", "reload", "diagnostics"]],
			["/lsp re", ["reload"]],
			["/export j", ["jsonl"]],
			["/thinking", before.thinkingLevels],
			["/unknown ", []],
		];
		for (const [text, expected] of cases) {
			const items = await host.query({ query: "complete", text });
			expect(items.map((item) => item.value)).toEqual(expected);
		}
		expect(readSnapshot(host).history).toEqual(before.history);
		expect(readSnapshot(host).messages).toEqual(before.messages);
		expect(server.requests).toHaveLength(0);
	});

	it("视图接口不提交提示、不写输入历史，重载后工具配置仍可直接调用", async () => {
		const before = readSnapshot(host);
		for (const view of ["usage", "system"])
			await host.dispatch({ action: "view", view });
		expect(events.filter((event) => event.type === "panel").map((event) => event.panel.kind)).toEqual(["usage", "system"]);
		expect(readSnapshot(host).history).toEqual(before.history);
		expect(readSnapshot(host).messages).toEqual(before.messages);
		expect(readSnapshot(host).entries).toEqual(before.entries);
		expect(server.requests.filter((request) => Array.isArray(request.messages))).toHaveLength(0);
		await host.dispatch({ action: "reload" });
		await host.dispatch({ action: "tool", name: "websearch", enabled: false });
		expect(readSnapshot(host).tools.find((tool) => tool.name === "websearch")?.enabled).toBe(false);
		expect(readSnapshot(host).history).toEqual(before.history);
		expect(server.requests.filter((request) => Array.isArray(request.messages))).toHaveLength(0);
	});

	it("读取共享目录中各工作区的已有历史，不需要导入", async () => {
		delete process.env.PI_CODING_AGENT_DIR;
		const file = await storeSession({
			cwd: path.join(cwd, "other-project"),
			agentDir: path.join(temp.path, ".pi", "agent"),
			provider: "gui-fixture",
			name: "已有 TUI 会话",
		});
		const original = await readFile(file, "utf8");
		await host.dispatch({ action: "sessions" });
		expect(events.filter((event) => event.type === "sessions").at(-1)?.value).toEqual([
			expect.objectContaining({ path: file, cwd: path.join(cwd, "other-project"), title: "已有 TUI 会话" }),
		]);
		expect(await readFile(file, "utf8")).toBe(original);
		expect(events.some((event) => event.type === "panel")).toBe(false);
		await host.dispatch(prompt("/resume"));
		expect(events.some((event) => event.type === "panel" && event.panel.kind === "sessions")).toBe(true);
	});

	it("启动自动加载历史，使用配置目录覆盖并向重连页面重放索引", async () => {
		await host.host.dispose();
		const agentDir = path.join(temp.path, "custom-agent");
		await cp(path.join(temp.path, ".pi", "agent"), agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const file = await storeSession({ cwd, agentDir, provider: "gui-fixture", name: "自定义目录历史" });
		host = new GuiHost().createClient();
		events = [];
		host.subscribe((event) => events.push(event));
		await host.host.start(cwd);
		await expect.poll(() => events.filter((event) => event.type === "sessions").at(-1)?.value).toEqual([
			expect.objectContaining({ path: file, title: "自定义目录历史" }),
		]);
		const replay: GuiEvent[] = [];
		const unsubscribe = host.subscribe((event) => replay.push(event));
		host.replay((event) => replay.push(event));
		expect(replay.filter((event) => event.type === "sessions").at(-1)?.value).toEqual([
			expect.objectContaining({ path: file }),
		]);
		unsubscribe();
	});

	it("索引保留完整工作目录，按活动时间排序且只传输列表元数据", async () => {
		const options = { agentDir: path.join(temp.path, ".pi", "agent"), provider: "gui-fixture" };
		const first = await storeSession({ ...options, cwd: path.join(cwd, "a", "project"), name: "较早会话", timestamp: 1000 });
		const second = await storeSession({ ...options, cwd: path.join(cwd, "b", "project"), text: "未命名\n历史问题", timestamp: 2000 });
		await host.dispatch({ action: "sessions" });
		const items = events.filter((event) => event.type === "sessions").at(-1)?.value;
		expect(items).toEqual([
			{ path: second, cwd: path.join(cwd, "b", "project"), title: "未命名 历史问题", modified: new Date(2000).toISOString() },
			{ path: first, cwd: path.join(cwd, "a", "project"), title: "较早会话", modified: new Date(1000).toISOString() },
		]);
	});

	it("恢复历史同时切换工作区，文件工具使用该目录，重命名和新建自动更新列表", async () => {
		const other = path.join(cwd, "another-project");
		const file = await storeSession({ cwd: other, agentDir: path.join(temp.path, ".pi", "agent"), provider: "gui-fixture", name: "待恢复" });
		await writeFile(path.join(other, "input.txt"), "other workspace\n");
		await host.dispatch({ action: "openSession", path: file });
		expect(readSnapshot(host)).toMatchObject({ cwd: other, sessionFile: file, name: "待恢复" });
		expect(JSON.stringify(readSnapshot(host).messages)).toContain("历史回复");
		await host.dispatch(prompt("继续检查文件"));
		expect(await readFile(path.join(other, "output.txt"), "utf8")).toBe("GUI SDK result\n");
		await expect(readFile(path.join(cwd, "output.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		await Promise.all([
			host.dispatch({ action: "sessions" }),
			host.dispatch({ action: "rename", name: "已重命名" }),
		]);
		await expect.poll(() => events.filter((event) => event.type === "sessions").at(-1)?.value).toEqual([
			expect.objectContaining({ path: file, title: "已重命名" }),
		]);
		await host.dispatch({ action: "new" });
		expect(readSnapshot(host).cwd).toBe(other);
		expect(readSnapshot(host).messages).toHaveLength(0);
		await host.dispatch(prompt("新会话检查文件"));
		await expect.poll(() => events.filter((event) => event.type === "sessions").at(-1)?.value.length).toBe(2);
	});

	it("工作区或会话文件已被删除时不破坏当前会话，刷新移除失效文件", async () => {
		const other = path.join(cwd, "removed-workspace");
		const file = await storeSession({ cwd: other, agentDir: path.join(temp.path, ".pi", "agent"), provider: "gui-fixture" });
		const id = readSnapshot(host).sessionId;
		await rm(other, { recursive: true });
		await host.dispatch({ action: "sessions" });
		expect(events.filter((event) => event.type === "sessions").at(-1)?.value).toEqual([expect.objectContaining({ path: file })]);
		await expect(host.dispatch({ action: "openSession", path: file })).rejects.toMatchObject({ code: "ENOENT" });
		expect(readSnapshot(host).sessionId).toBe(id);
		await rm(file);
		await expect(host.dispatch({ action: "openSession", path: file })).rejects.toMatchObject({ code: "ENOENT" });
		expect(readSnapshot(host).sessionId).toBe(id);
		await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
		await host.dispatch({ action: "sessions" });
		expect(events.filter((event) => event.type === "sessions").at(-1)?.value).toEqual([]);
	});

	it("真实文件工具回路、会话恢复和结构化面板，不启动 CLI 或 RPC", async () => {
		await host.dispatch(prompt("Read input, write output"));
		expect(await readFile(path.join(cwd, "output.txt"), "utf8")).toBe("GUI SDK result\n");
		expect(JSON.stringify(readSnapshot(host).messages)).toContain("GUI completed");
		expect(JSON.stringify(readSnapshot(host))).not.toContain("private-fixture-secret");
		const file = readSnapshot(host).sessionFile;
		expect(file).not.toBeNull();
		for (const command of ["/stats", "/system", "/tools", "/usage", "/telemetry", "/model", "/scoped-models", "/tree"])
			await host.dispatch(prompt(command));
		expect(events.filter((event) => event.type === "panel").map((event) => event.panel.kind))
			.toEqual(["system", "tools", "usage", "model", "model"]);
		expect(events.filter((event) => event.type === "sessionTab").map((event) => event.tab))
			.toEqual(["stats", "telemetry", "tree"]);
		await host.dispatch({ action: "tool", name: "websearch", enabled: false });
		expect(readSnapshot(host).tools.find((tool) => tool.name === "websearch")?.enabled).toBe(false);
		await host.dispatch({ action: "new" });
		expect(readSnapshot(host).messages).toHaveLength(0);
		await host.dispatch({ action: "openSession", path: file });
		expect(JSON.stringify(readSnapshot(host).messages)).toContain("GUI completed");
		expect(readSnapshot(host).tools.find((tool) => tool.name === "websearch")?.enabled).toBe(false);
	});

	it("读取历史不执行项目扩展，跨工作区恢复仍需确认项目信任", async () => {
		const other = path.join(cwd, "untrusted-project");
		const agentDir = path.join(temp.path, ".pi", "agent");
		const file = await storeSession({ cwd: other, agentDir, provider: "gui-fixture", name: "待确认项目" });
		await mkdir(path.join(other, ".pi", "extensions"), { recursive: true });
		const marker = path.join(other, "executed.txt");
		await writeFile(path.join(other, ".pi", "extensions", "project.ts"),
			`import {writeFileSync} from 'node:fs'; export default function () { writeFileSync(${JSON.stringify(marker)}, 'executed'); }`);
		await host.host.dispose();
		const settingsFile = path.join(agentDir, "settings.json");
		const settings = JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>;
		await writeFile(settingsFile, JSON.stringify({ ...settings, defaultProjectTrust: "ask" }));
		// 隔离初始工作区，避免仓库上级的技能触发额外信任确认。
		const initial = path.join(temp.path, "initial-workspace");
		await mkdir(initial);
		host = new GuiHost().createClient();
		await host.host.start(initial);
		await host.dispatch({ action: "sessions" });
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
		const switching = host.dispatch({ action: "openSession", path: file });
		await expect.poll(() => host.execution.dialogs.list().length).toBe(1);
		const dialog = host.execution.dialogs.list()[0];
		if (!dialog) throw new Error("缺少项目信任确认");
		await host.dispatch({ action: "sessions" });
		await host.dispatch({ action: "dialog", id: dialog.id, value: "不信任" });
		await switching;
		expect(readSnapshot(host).cwd).toBe(other);
		expect(JSON.stringify(readSnapshot(host).messages)).toContain("历史回复");
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
		await host.dispatch({ action: "new" });
		expect(host.execution.dialogs.list()).toEqual([]);
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("模型范围修改仅影响会话，显式保存顺序并在重启后恢复，直接切换不改默认或范围", async () => {
		const settingsFile = path.join(temp.path, ".pi", "agent", "settings.json");
		const scope = ["gui-fixture/second", "gui-fixture/test"];
		await host.dispatch({ action: "scopeModels", models: scope });
		expect(readSnapshot(host).scopedModels).toEqual(scope);
		expect(JSON.parse(await readFile(settingsFile, "utf8"))).not.toHaveProperty("enabledModels");
		await host.host.dispose();
		host = new GuiHost().createClient();
		await host.host.start(cwd);
		expect(readSnapshot(host).scopedModels).toEqual([]);

		await host.dispatch({ action: "scopeModels", models: scope });
		await host.dispatch({ action: "persistModels" });
		expect(JSON.parse(await readFile(settingsFile, "utf8"))).toMatchObject({ enabledModels: scope });
		await host.dispatch({ action: "model", provider: "gui-fixture", id: "third" });
		expect(readSnapshot(host).model?.id).toBe("third");
		expect(readSnapshot(host).scopedModels).toEqual(scope);
		expect(host.runtime.services.settingsManager.getDefaultModel()).toBe("test");
		await host.host.dispose();
		host = new GuiHost().createClient();
		await host.host.start(cwd);
		expect(readSnapshot(host).scopedModels).toEqual(scope);
		expect(readSnapshot(host).model?.id).toBe("test");

		await host.dispatch({ action: "scopeModels", models: [] });
		await host.dispatch({ action: "persistModels" });
		expect(JSON.parse(await readFile(settingsFile, "utf8"))).toMatchObject({ enabledModels: [] });
		await host.host.dispose();
		host = new GuiHost().createClient();
		await host.host.start(cwd);
		expect(readSnapshot(host).scopedModels).toEqual([]);
	});

	it("模型范围拒绝失效目录项，保存失败可见且可以重新保存", async () => {
		const scope = ["gui-fixture/second"];
		await host.dispatch({ action: "scopeModels", models: scope });
		await expect(host.dispatch({ action: "scopeModels", models: ["gui-fixture/unavailable"] })).rejects.toThrow(
			"模型不可用",
		);
		expect(readSnapshot(host).scopedModels).toEqual(scope);
		const settingsFile = path.join(temp.path, ".pi", "agent", "settings.json");
		const original = await readFile(settingsFile, "utf8");
		await writeFile(settingsFile, "{ incomplete");
		await expect(host.dispatch({ action: "persistModels" })).rejects.toThrow("模型保存失败");
		expect(await readFile(settingsFile, "utf8")).toBe("{ incomplete");
		await writeFile(settingsFile, original);
		await host.dispatch({ action: "persistModels" });
		expect(JSON.parse(await readFile(settingsFile, "utf8"))).toMatchObject({ enabledModels: scope });
	});

	it("调整模型顺序并保存时保留已有的逐模型思考配置", async () => {
		const settings = host.runtime.services.settingsManager;
		settings.setEnabledModels(["gui-fixture/test:off", "gui-fixture/second"]);
		await settings.flush();
		await host.host.dispose();
		host = new GuiHost().createClient();
		await host.host.start(cwd);
		await host.dispatch({ action: "scopeModels", models: ["gui-fixture/second", "gui-fixture/test"] });
		await host.dispatch({ action: "persistModels" });
		expect(JSON.parse(await readFile(path.join(temp.path, ".pi", "agent", "settings.json"), "utf8"))).toMatchObject({
			enabledModels: ["gui-fixture/second", "gui-fixture/test:off"],
		});
	});

	it("审批在界面重连后仍存在，拒绝不写文件，旧响应不可再次消费", async () => {
		await writeFile(
			path.join(temp.path, ".pi", "agent", "configs", "approval-gate.jsonc"),
			'{"tools":{"write":{"default_action":"ask"}}}',
		);
		const task = host.dispatch(prompt("Write output"));
		await expect.poll(() => host.execution.dialogs.list().length).toBe(1);
		const dialog = host.execution.dialogs.list()[0];
		if (!dialog) throw new Error("Missing approval");
		await host.dispatch({ action: "sessions" });
		expect(host.execution.dialogs.list()[0]?.id).toBe(dialog.id);
		const waitingSession = readSnapshot(host).sessionId;
		await host.dispatch({ action: "new" });
		expect(host.execution.dialogs.list()).toEqual([]);
		await host.dispatch({ action: "openSession", id: waitingSession });
		const replay: GuiEvent[] = [];
		const unsubscribe = host.subscribe((event) => replay.push(event));
		host.replay((event) => replay.push(event));
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
		const id = readSnapshot(host).sessionId;
		await expect(host.dispatch({ action: "workspace", path: path.join(cwd, "missing") })).rejects.toThrow();
		expect(readSnapshot(host).sessionId).toBe(id);
		const original = await host.query({ query: "config", file: "settings.json" });
		const file = path.join(temp.path, ".pi", "agent", "settings.json");
		await writeFile(file, `${original}\n`);
		await expect(
			host.dispatch({ action: "saveConfig", file: "settings.json", original: original, content: "{}" }),
		).rejects.toThrow("已被修改");
		expect(await readFile(file, "utf8")).toBe(`${original}\n`);
	});

	it("未信任的项目扩展不执行，关闭启动中的信任对话框可释放宿主", async () => {
		await host.host.dispose();
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
		host = new GuiHost().createClient();
		const start = host.host.start(cwd);
		await expect.poll(() => host.execution.dialogs.list().length).toBe(1);
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
		await host.host.dispose();
		await start;
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each([
		{ operation: "compact", shutdown: false },
		{ operation: "compact", shutdown: true },
		{ operation: "navigate", shutdown: false },
		{ operation: "navigate", shutdown: true },
	] as const)("$operation 等待模型时取消，shutdown=$shutdown", async ({ operation, shutdown }) => {
		await host.dispatch(prompt("第一轮"));
		const firstLeaf = host.runtime.session.sessionManager.getLeafId();
		if (!firstLeaf) throw new Error("缺少分支起点");
		await host.dispatch(prompt("第二轮"));
		const session = host.runtime.session;
		const entries = session.sessionManager.getEntries();
		const summaryStarted = deferred<void>();
		const summary = deferred<ModelResponse>();
		titleReply = () => { summaryStarted.resolve(); return summary.promise; };
		const task = host.dispatch(operation === "compact"
			? { action: "compact" }
			: { action: "navigate", entryId: firstLeaf, summarize: true })
			.then(() => undefined, (error: unknown) => error);
		try {
			await summaryStarted.promise;
			if (shutdown) await host.host.dispose();
			else await host.dispatch({ action: "abort" });
			await task;
			expect(session.isIdle).toBe(true);
			expect(session.isCompacting).toBe(false);
			expect(session.sessionManager.getEntries()).toEqual(entries);
		} finally {
			summary.resolve({ text: "不应保存的摘要" });
			await task;
		}
	});

	it("用户 Shell 消息可经 JSONL 导出导入恢复", async () => {
		await host.dispatch(prompt("!printf gui-shell"));
		expect(JSON.stringify(readSnapshot(host).messages)).toContain("gui-shell");
		await host.dispatch({ action: "export", format: "jsonl" });
		const download = events.find((event) => event.type === "download");
		if (!download || download.type !== "download") throw new Error("Missing export");
		await host.dispatch({ action: "new" });
		await host.dispatch({ action: "import", content: download.content });
		expect(JSON.stringify(readSnapshot(host).messages)).toContain("gui-shell");
	});
});
