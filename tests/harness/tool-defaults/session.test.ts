import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	createAgentSessionFromServices, createAgentSessionServices, createAgentSessionRuntime,
	SessionManager, type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolsExtension } from "../../../src/harness/extensions/cmd-slash-tools.ts";
import type { ToolSelectionController } from "../../../src/harness/tool-defaults/controller.ts";
import { startModelServer } from "../../cli/model-server.ts";
import { preserveEnv, setTestHome, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("opi-tools-session-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_TOOLS_CONFIG", "PI_TOOLS_PROJECT_CONFIG", "PI_TOOLS_PROJECT_ROOT");
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
	process.env.PI_TOOLS_CONFIG = path.join(agentDir, "tools.jsonc");
	delete process.env.PI_TOOLS_PROJECT_CONFIG;
	delete process.env.PI_TOOLS_PROJECT_ROOT;
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	server = await startModelServer(() => ({ text: "done" }));
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "fixture", defaultModel: "test", defaultThinkingLevel: "off",
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

async function start(manager = SessionManager.create(cwd)) {
	let controller: ToolSelectionController | undefined;
	runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir,
			resourceLoaderOptions: {
				noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
				extensionFactories: [{ name: "tools", factory: createToolsExtension(undefined, undefined, (value) => { controller = value; }) }],
			},
		});
		return {
			...await createAgentSessionFromServices({ services, sessionManager, tools: ["read", "bash", "write"], ...(sessionStartEvent ? { sessionStartEvent } : {}) }),
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
