import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	createAgentSessionFromServices, createAgentSessionServices, createAgentSessionRuntime,
	SessionManager, type AgentSessionRuntime, type ExtensionAPI, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import shellTools from "../../../src/harness/extensions/shell-tools.ts";
import { extensions } from "../../../src/harness/extensions.ts";
import { createToolsExtension } from "../../../src/harness/extensions/cmd-slash-tools.ts";
import type { ToolSelectionController } from "../../../src/harness/tool-defaults/controller.ts";
import { startModelServer } from "../../cli/model-server.ts";
import { preserveEnv, setTestHome, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("opi-tools-session-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_OFFLINE");
let cwd: string;
let agentDir: string;
let runtime: AgentSessionRuntime | undefined;
let server: Awaited<ReturnType<typeof startModelServer>>;

beforeEach(async () => {
	setTestHome(temp.path);
	cwd = path.join(temp.path, "workspace");
	agentDir = path.join(temp.path, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	server = await startModelServer(() => ({ text: "done" }));
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "fixture", defaultModel: "test", defaultThinkingLevel: "off",
		defaultTools: ["read", "bash", "write"], codemode: { mode: "on" },
		compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture",
		models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
});

afterEach(async () => {
	await runtime?.dispose();
	runtime = undefined;
	await server.close();
});

async function start(manager = SessionManager.create(cwd), tools?: string[], fixture?: ExtensionFactory) {
	let controller: ToolSelectionController | undefined;
	runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir,
			resourceLoaderOptions: {
				noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
				extensionFactories: [
					...extensions.filter((extension) => extension.name === "codemode" || extension.name === "tool-search"),
					...(fixture ? [{ name: "fixture", factory: fixture }] : []),
					{ name: "tools", factory: createToolsExtension({ bindController: (value) => { controller = value; }, startup: tools === undefined ? {} : { tools } }) },
				],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		return {
			...await createAgentSessionFromServices({ services, sessionManager, ...(tools ? { tools } : {}), ...(sessionStartEvent ? { sessionStartEvent } : {}) }),
			services, diagnostics: services.diagnostics,
		};
	}, { cwd, agentDir, sessionManager: manager });
	await runtime.session.bindExtensions({ mode: "print" });
	if (!controller) throw new Error("工具选择未绑定");
	return { session: runtime.session, controller };
}

function registerOrdinaryTool(pi: ExtensionAPI): void {
	pi.registerTool({ name: "ordinary", label: "Ordinary", description: "Ordinary", parameters: Type.Object({}),
		async execute() { return { content: [], details: {} }; } });
}

function selected(controller: ToolSelectionController): string[] {
	return controller.listTools().filter((tool) => tool.enabled).map((tool) => tool.name);
}

function requestedTools(): string[] {
	return server.requests.at(-1)?.tools?.map((tool) => tool.function.name) ?? [];
}

describe("工具选择与 SDK 状态", () => {
	it.skipIf(process.platform !== "win32")("Windows 从工具面板启用 PowerShell 后向模型声明", async () => {
		const { session, controller } = await start(SessionManager.create(cwd), undefined, shellTools);
		expect(controller.listTools().find((tool) => tool.name === "powershell")).toMatchObject({ available: true, enabled: false });
		controller.set("powershell", true);
		await session.prompt("查询工具");
		expect(requestedTools()).toContain("powershell");
	});

	it.skipIf(process.platform !== "win32")("导航到首次请求前的节点保留手动选择的 Bash", async () => {
		const file = path.join(agentDir, "settings.json");
		const { defaultTools: _defaults, ...settings } = JSON.parse(await readFile(file, "utf8"));
		await writeFile(file, JSON.stringify(settings));
		const { session, controller } = await start(SessionManager.create(cwd), undefined, shellTools);
		const beforeRequest = session.sessionManager.getLeafId();
		if (!beforeRequest) throw new Error("缺少会话起始节点");
		expect(selected(controller)).toContain("powershell");
		expect(selected(controller)).not.toContain("bash");
		await session.prompt("使用默认工具");
		controller.setMany([{ name: "powershell", enabled: false }, { name: "bash", enabled: true }]);
		await session.navigateTree(beforeRequest, { summarize: false });
		await session.prompt("使用手动选择的工具");
		expect(requestedTools()).toContain("bash");
		expect(requestedTools()).not.toContain("powershell");
	});

	it("没有候选工具时，显式选择 tool_search 也不向模型声明", async () => {
		const { session, controller } = await start(SessionManager.create(cwd), ["tool_search"]);
		expect(controller.listTools().find((tool) => tool.name === "tool_search")).toMatchObject({ available: false, enabled: false });
		await session.prompt("没有可搜索工具");
		expect(requestedTools()).not.toContain("tool_search");
	});

	it.each(["settings", "CLI"])("%s 排除搜索后，重载保留排除项和会话选择", async (source) => {
		const file = path.join(agentDir, "settings.json");
		const settings = JSON.parse(await readFile(file, "utf8"));
		const defaults = source === "CLI" ? ["read", "tool_search"] : ["read", "-tool_search"];
		await writeFile(file, JSON.stringify({ ...settings, defaultTools: defaults }));
		const { session, controller } = await start(SessionManager.create(cwd), source === "CLI" ? ["-tool_search"] : undefined, (pi) => {
			pi.registerTool({ name: "fixture", label: "Fixture", description: "Fixture", exposure: "deferred", parameters: Type.Object({}),
				async execute() { return { content: [], details: {} }; } });
		});
		controller.set("write", true);
		await session.prompt("使用显式排除");
		expect(requestedTools()).toEqual(["read", "write"]);
		await session.reload();
		await session.prompt("重载后继续");
		expect(requestedTools()).toEqual(["read", "write"]);
	});

	it("首次请求前重载保留选择，不启用重新注册的普通扩展工具", async () => {
		const { session, controller } = await start(SessionManager.create(cwd), undefined, registerOrdinaryTool);
		controller.set("bash", false);
		await session.reload();
		await session.prompt("沿用当前选择");
		expect(requestedTools()).toEqual(["read", "write"]);
	});

	it("恢复空工具分支时不启用新安装的普通工具，但允许手动选择", async () => {
		let host = await start(SessionManager.create(cwd), ["-tool_search"]);
		host.controller.setMany(selected(host.controller).map((name) => ({ name, enabled: false })));
		await host.session.prompt("不用工具");
		expect(requestedTools()).toEqual([]);
		const file = host.session.sessionFile;
		if (!file) throw new Error("缺少会话文件");
		await runtime?.dispose();
		host = await start(SessionManager.open(file), ["-tool_search"], registerOrdinaryTool);
		await host.session.prompt("继续不用工具");
		expect(requestedTools()).toEqual([]);
		host.controller.set("ordinary", true);
		await host.session.prompt("使用新工具");
		expect(requestedTools()).toEqual(["ordinary"]);
	});

	it("SDK 显式工具选择优先于已保存的默认值", async () => {
		let host = await start();
		host.controller.set("bash", false);
		await host.controller.persistUserDefaults();
		await runtime?.dispose();
		host = await start(SessionManager.create(cwd), ["bash"]);
		expect(selected(host.controller)).toEqual(["bash"]);
		await host.session.prompt("使用显式工具选择");
		expect(requestedTools()).toEqual(["bash"]);
	});

	it("保存 codemode 后由 SDK 在新会话启用", async () => {
		let host = await start();
		host.controller.set("codemode", true);
		await host.controller.persistUserDefaults();
		await runtime?.dispose();
		host = await start();
		expect(selected(host.controller)).toContain("codemode");
		await host.session.prompt("使用保存的脚本入口");
		expect(requestedTools()).toEqual(["codemode"]);
	});

	it("保存全局默认值后，新会话使用保存的选择，旧会话仍使用分支选择", async () => {
		let host = await start();
		host.controller.set("bash", false);
		await host.controller.persistUserDefaults();
		host.controller.set("read", false);
		await host.session.prompt("保存分支选择");
		const file = host.session.sessionFile;
		if (!file) throw new Error("缺少会话文件");
		await runtime?.dispose();
		host = await start();
		expect(selected(host.controller)).toEqual(["read", "write"]);
		await host.session.prompt("使用全局默认值");
		expect(requestedTools()).toEqual(["read", "write"]);
		await runtime?.dispose();
		host = await start(SessionManager.open(file));
		expect(selected(host.controller)).toEqual(["write"]);
	});

	it("切换 codemode 只隐藏或恢复普通声明，不改变已选工具", async () => {
		const { session, controller } = await start();
		await session.prompt("直接调用");
		expect(requestedTools()).toEqual(["read", "bash", "write"]);
		expect(controller.listTools().map((tool) => tool.name)).toContain("codemode");
		controller.set("codemode", true);
		await session.prompt("脚本调用");
		expect(requestedTools()).toEqual(["codemode"]);
		expect(selected(controller)).toEqual(expect.arrayContaining(["read", "bash", "write", "codemode"]));
		const scriptDescription = server.requests.at(-1)?.tools?.[0]?.function.description;
		expect(scriptDescription).toContain("read(args:");
		expect(scriptDescription).toContain("`models`");
		controller.set("read", false);
		await session.prompt("更新脚本目录");
		const updated = server.requests.at(-1)?.tools?.[0]?.function.description;
		expect(updated).not.toContain("read(args:");
		expect(updated).toContain("write(args:");
		expect(updated).toContain("`models`");
		controller.set("read", true);
		controller.set("codemode", false);
		await session.prompt("恢复直接调用");
		expect(requestedTools()).toEqual(["bash", "write", "read"]);
		expect(selected(controller)).toEqual(["read", "bash", "write"]);
	});

	it("恢复会话和导航分支后，codemode 仍只声明脚本入口", async () => {
		let host = await start();
		host.controller.set("codemode", true);
		await host.session.prompt("脚本分支");
		const leaf = host.session.sessionManager.getLeafId();
		const file = host.session.sessionFile;
		if (!leaf || !file) throw new Error("缺少分支或会话文件");
		await runtime?.dispose();
		host = await start(SessionManager.open(file));
		await host.session.prompt("恢复脚本分支");
		expect(requestedTools()).toEqual(["codemode"]);
		host.controller.set("codemode", false);
		await host.session.prompt("直接调用分支");
		expect(requestedTools()).toEqual(["read", "bash", "write"]);
		await host.session.navigateTree(leaf, { summarize: false });
		await host.session.prompt("回到脚本分支");
		expect(requestedTools()).toEqual(["codemode"]);
	});

	it("恢复手动选择时保持声明顺序，不追加重复 system 消息", async () => {
		let host = await start();
		host.controller.set("bash", false);
		await host.session.prompt("保存当前工具状态");
		expect(requestedTools()).toEqual(["read", "write"]);
		const systems = host.session.messages.filter((message) => message.role === "system");
		const file = host.session.sessionFile;
		if (!file) throw new Error("缺少会话文件");
		await runtime?.dispose();
		host = await start(SessionManager.open(file));
		await host.session.prompt("继续");
		expect(requestedTools()).toEqual(["read", "write"]);
		expect(host.session.messages.filter((message) => message.role === "system")).toEqual(systems);
	});

	it("未发送请求的选择不持久化，导航分支使用 SDK 声明", async () => {
		let host = await start();
		host.controller.set("bash", false);
		await host.session.prompt("第一个分支");
		const leaf = host.session.sessionManager.getLeafId();
		const file = host.session.sessionFile;
		if (!leaf || !file) throw new Error("缺少分支或会话文件");
		host.controller.set("read", false);
		expect(selected(host.controller)).toEqual(["write"]);
		await runtime?.dispose();
		host = await start(SessionManager.open(file));
		expect(selected(host.controller)).toEqual(["read", "write"]);
		host.controller.set("read", false);
		await host.session.prompt("第二个分支");
		expect(requestedTools()).toEqual(["write"]);
		await host.session.navigateTree(leaf, { summarize: false });
		expect(selected(host.controller)).toEqual(["read", "write"]);
		await host.session.prompt("回到第一个分支");
		expect(requestedTools()).toEqual(["read", "write"]);
	});
});
