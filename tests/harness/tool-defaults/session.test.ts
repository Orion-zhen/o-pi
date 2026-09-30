import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	createAgentSessionFromServices, createAgentSessionServices, createAgentSessionRuntime,
	SessionManager, type AgentSessionRuntime, type ExtensionAPI, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
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
					{ name: "tools", factory: createToolsExtension(undefined, undefined, (value) => { controller = value; }) },
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

function selected(controller: ToolSelectionController): string[] {
	return controller.listTools().filter((tool) => tool.enabled).map((tool) => tool.name);
}

function requestedTools(): string[] {
	return server.requests.at(-1)?.tools?.map((tool) => tool.function.name) ?? [];
}

describe("工具选择与 SDK 状态", () => {
	it("没有候选工具时，显式配置和手动操作都不能启用 tool_search", async () => {
		const { session, controller } = await start(SessionManager.create(cwd), ["tool_search"]);
		expect(controller.listTools().find((tool) => tool.name === "tool_search")).toMatchObject({ available: false, enabled: false });
		controller.set("tool_search", true);
		expect(session.getActiveToolNames()).not.toContain("tool_search");
		await session.prompt("没有可搜索工具");
		expect(requestedTools()).not.toContain("tool_search");
	});

	it.each(["codemode", "deferred"] as const)("%s 候选全部激活或隐藏后关闭搜索，候选恢复后不自动启用", async (exposure) => {
		let api: ExtensionAPI | undefined;
		const candidate = {
			name: "fixture", label: "Fixture", description: "Fixture records", exposure,
			parameters: Type.Object({}),
			async execute() { return { content: [{ type: "text" as const, text: "record" }], details: {} }; },
		};
		const { session, controller } = await start(SessionManager.create(cwd), undefined, (pi) => {
			api = pi;
			pi.registerTool(candidate);
		});
		if (!api) throw new Error("测试扩展未绑定");
		const search = () => controller.listTools().find((tool) => tool.name === "tool_search");
		controller.set("tool_search", true);
		expect(search()).toMatchObject({ available: true, enabled: true });
		session.setActiveToolsByName(["tool_search", "fixture"]);
		await Promise.resolve();
		expect(search()).toMatchObject({ available: false, enabled: false });
		expect(session.getActiveToolNames()).toEqual(["fixture"]);
		controller.set("tool_search", true);
		expect(session.getActiveToolNames()).toEqual(["fixture"]);

		controller.set("fixture", false);
		expect(search()).toMatchObject({ available: true, enabled: false });
		controller.set("tool_search", true);
		api.registerTool({ ...candidate, exposure: "hidden" });
		await Promise.resolve();
		expect(search()).toMatchObject({ available: false, enabled: false });
		expect(session.getActiveToolNames()).not.toContain("tool_search");

		api.registerTool(candidate);
		expect(search()).toMatchObject({ available: true, enabled: false });
		controller.set("tool_search", true);
		await session.prompt("候选恢复后重新启用搜索");
		expect(requestedTools()).toContain("tool_search");
		controller.set("fixture", true);
		expect(search()).toMatchObject({ available: false, enabled: false });
		expect(session.getActiveToolNames()).toEqual(["fixture"]);
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
		expect(scriptDescription).not.toContain("Model API");
		controller.set("read", false);
		await session.prompt("更新脚本目录");
		const updated = server.requests.at(-1)?.tools?.[0]?.function.description;
		expect(updated).not.toContain("read(args:");
		expect(updated).toContain("write(args:");
		expect(updated).not.toContain("Model API");
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

	it("SDK 改变工具后，选择器与下一次请求使用同一状态", async () => {
		const { session, controller } = await start();
		session.setActiveToolsByName(["bash"]);
		expect(selected(controller)).toEqual(["bash"]);
		controller.set("write", true);
		await session.prompt("使用当前工具");
		expect(requestedTools()).toEqual(["bash", "write"]);
		expect(selected(controller)).toEqual(["bash", "write"]);
	});

	it("恢复手动选择时保持声明顺序，不追加重复 system 消息", async () => {
		let host = await start();
		host.session.setActiveToolsByName(["write", "read", "bash"]);
		host.controller.set("bash", false);
		await host.session.prompt("保存当前工具状态");
		const systems = host.session.messages.filter((message) => message.role === "system");
		const file = host.session.sessionFile;
		if (!file) throw new Error("缺少会话文件");
		await runtime?.dispose();
		host = await start(SessionManager.open(file));
		expect(host.session.getActiveToolNames()).toEqual(["write", "read"]);
		expect(selected(host.controller)).toEqual(["read", "write"]);
		await host.session.prompt("继续");
		expect(requestedTools()).toEqual(["write", "read"]);
		expect(host.session.messages.filter((message) => message.role === "system")).toEqual(systems);
	});

	it("恢复手动选择后新增的原生工具声明", async () => {
		let host = await start();
		host.controller.set("bash", false);
		await host.session.prompt("保存手动选择");
		host.session.setActiveToolsByName(["read", "write", "bash"]);
		expect(host.session.getActiveToolNames()).toEqual(["read", "write", "bash"]);
		await host.session.prompt("使用新发现的工具");
		const file = host.session.sessionFile;
		if (!file) throw new Error("缺少会话文件");
		await runtime?.dispose();
		host = await start(SessionManager.open(file));
		expect(selected(host.controller)).toEqual(["read", "bash", "write"]);
		await host.session.prompt("恢复后继续");
		expect(requestedTools()).toEqual(["read", "write", "bash"]);
	});

	it("手动切换后尚未发送请求也能恢复，导航回旧分支恢复旧选择", async () => {
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
		expect(selected(host.controller)).toEqual(["write"]);
		await host.session.prompt("第二个分支");
		expect(requestedTools()).toEqual(["write"]);
		await host.session.navigateTree(leaf, { summarize: false });
		expect(selected(host.controller)).toEqual(["read", "write"]);
		await host.session.prompt("回到第一个分支");
		expect(requestedTools()).toEqual(["read", "write"]);
	});
});
