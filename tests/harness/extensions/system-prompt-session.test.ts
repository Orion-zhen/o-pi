import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices, createAgentSessionServices, createAgentSessionRuntime,
	SessionManager, type AgentSessionRuntime, type FileEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import systemPrompt from "../../../src/harness/extensions/system-prompt.ts";
import { startModelServer } from "../../cli/model-server.ts";
import { preserveEnv, setTestHome, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("opi-prompt-transcript-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SUBAGENT_CHILD", "PI_SUBAGENT_FORK", "PI_SUBAGENT_FORK_SYSTEM_PROMPT_FILE");
let cwd: string;
let agentDir: string;
let note: string;
let activeTools: string[];
let shown: string;
let runtime: AgentSessionRuntime | undefined;
let server: Awaited<ReturnType<typeof startModelServer>>;

beforeEach(async () => {
	setTestHome(temp.path);
	cwd = path.join(temp.path, "workspace");
	agentDir = path.join(temp.path, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_FORK;
	note = "PROJECT_ALPHA";
	activeTools = ["probe"];
	shown = "";
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	server = await startModelServer(() => ({ text: "done" }));
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "fixture", defaultModel: "patch", defaultThinkingLevel: "off",
		compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture",
		models: ["patch", "flat"].map((id) => ({
			id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsMidConvoSystemMessages: id === "patch", supportsMidConvoToolAdditions: id === "patch" },
		})),
	} } }));
});

afterEach(async () => {
	await runtime?.dispose();
	runtime = undefined;
	await server.close();
});

async function start(entries?: FileEntry[]) {
	runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir,
			resourceLoaderOptions: {
				noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
				extensionFactories: [
					{ name: "prompt-inputs", factory: (pi) => {
						for (const name of ["probe", "extra"]) pi.registerTool({
							name, label: name, description: name, parameters: Type.Object({}),
							promptGuidelines: [`Use ${name} only for its declared purpose.`],
							async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
						});
						pi.on("before_agent_start", (event) => {
							event.systemPromptOptions.contextFiles = [{ path: "AGENTS.md", content: note }];
							event.systemPromptOptions.selectedTools = [...activeTools];
						});
					} },
					{ name: "system-prompt", factory: (pi) => systemPrompt(pi, {
						mode: "tui", show: async (_ctx, prompt) => { shown = prompt; },
					}) },
				],
			},
		});
		return {
			...await createAgentSessionFromServices({ services, sessionManager, ...(sessionStartEvent ? { sessionStartEvent } : {}) }),
			services, diagnostics: services.diagnostics,
		};
	}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd, undefined, entries) });
	await runtime.session.bindExtensions({ mode: "tui" });
	return runtime;
}

describe("SDK 提示词增量", () => {
	it("相同指令不追加 system 消息，实际请求只包含精简提示词和启用工具规则", async () => {
		const { session } = await start();
		await session.prompt("first");
		const systems = session.messages.filter((message) => message.role === "system");
		await session.prompt("second");
		expect(session.messages.filter((message) => message.role === "system")).toEqual(systems);
		expect(server.requests[1]?.messages.slice(0, server.requests[0]?.messages.length)).toEqual(server.requests[0]?.messages);
		const prompt = getCurrentSystemPrompt(session.messages);
		expect(prompt).toContain("<tool_policy>");
		expect(prompt).toContain("Use probe only for its declared purpose.");
		expect(prompt).not.toContain("Use extra only for its declared purpose.");
		expect(prompt).not.toContain("You are an expert coding assistant");
		expect(prompt.match(/Workspace:/g)).toHaveLength(1);
		await session.prompt("/system");
		expect(shown).toBe(prompt);
	});

	it.each(["patch", "flat"])("%s 模型更新项目规则和工具，不重写已保存的前缀", async (id) => {
		const host = await start();
		const model = host.services.modelRuntime.getModel("fixture", id);
		if (!model) throw new Error("model missing");
		await host.session.setModel(model);
		await host.session.prompt("first");
		const original = structuredClone(host.session.messages);
		note = "PROJECT_BETA";
		activeTools = ["probe", "extra"];
		await host.session.prompt("second");
		expect(host.session.messages.slice(0, original.length)).toEqual(original);
		expect(getCurrentSystemPrompt(host.session.messages)).toContain("PROJECT_BETA");
		expect(getCurrentSystemPrompt(host.session.messages)).not.toContain("PROJECT_ALPHA");
		const request = server.requests.at(-1);
		expect(JSON.stringify(request)).toContain("PROJECT_BETA");
		if (id === "patch") expect(request?.messages.slice(0, server.requests[0]?.messages.length)).toEqual(server.requests[0]?.messages);
		else expect(JSON.stringify(request)).not.toContain("PROJECT_ALPHA");
	});

	it("压缩快照恢复后保留项目指令，未变更的段落不再追加", async () => {
		let host = await start();
		await host.session.prompt("first");
		note = "PROJECT_BETA";
		await host.session.prompt("second");
		const manager = host.session.sessionManager;
		const kept = manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user");
		if (!kept) throw new Error("user entry missing");
		const prompt = getCurrentSystemPrompt(host.session.messages);
		manager.appendCompaction("earlier work", kept.id, 10000);
		const entries = manager.getEntries();
		await host.dispose();
		host = await start(entries);
		const count = host.session.messages.filter((message) => message.role === "system").length;
		await host.session.prompt("after compaction");
		expect(getCurrentSystemPrompt(host.session.messages)).toBe(prompt);
		expect(host.session.messages.filter((message) => message.role === "system")).toHaveLength(count);
	});

	it.each([false, true])("fork 在指令和工具更新后逐字继承父提示词，compacted=%s", async (compacted) => {
		let host = await start();
		await host.session.prompt("parent");
		note = "PARENT_UPDATED";
		activeTools = ["probe", "extra"];
		await host.session.prompt("updated parent");
		const prompt = getCurrentSystemPrompt(host.session.messages);
		const manager = host.session.sessionManager;
		if (compacted) {
			const kept = manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user");
			if (!kept) throw new Error("user entry missing");
			manager.appendCompaction("earlier work", kept.id, 10000);
		}
		const entries = manager.getEntries();
		await host.dispose();
		const file = path.join(temp.path, "parent-prompt.txt");
		await writeFile(file, prompt);
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_SUBAGENT_FORK = "1";
		process.env.PI_SUBAGENT_FORK_SYSTEM_PROMPT_FILE = file;
		note = "CHILD_MUST_NOT_REPLACE_PARENT";
		host = await start(entries);
		await host.session.prompt("fork assignment");
		expect(server.requests.at(-1)?.messages[0]?.content).toBe(prompt);
		expect(prompt).toContain("PARENT_UPDATED");
		expect(server.requests.at(-1)?.tools?.map((tool) => tool.function.name)).toEqual(["probe", "extra"]);
		expect(JSON.stringify(server.requests.at(-1))).not.toContain(note);
		await host.session.prompt("/system");
		expect(shown).toBe(prompt);
	});

	it("恢复和分支导航重放各自的指令状态，模型切换使用当前指令", async () => {
		let host = await start();
		await host.session.prompt("first");
		const firstLeaf = host.session.sessionManager.getLeafId();
		if (!firstLeaf) throw new Error("leaf missing");
		note = "PROJECT_BETA";
		await host.session.prompt("second");
		const entries = host.session.sessionManager.getEntries();
		await host.dispose();
		host = await start(entries);
		await host.session.prompt("resume");
		expect(getCurrentSystemPrompt(host.session.messages)).toContain("PROJECT_BETA");
		await host.session.navigateTree(firstLeaf, { summarize: false });
		note = "PROJECT_ALPHA";
		await host.session.prompt("branch");
		expect(JSON.stringify(server.requests.at(-1))).not.toContain("PROJECT_BETA");
		const model = host.services.modelRuntime.getModel("fixture", "flat");
		if (!model) throw new Error("model missing");
		await host.session.setModel(model);
		await host.session.prompt("switch model");
		expect(JSON.stringify(server.requests.at(-1))).toContain("PROJECT_ALPHA");
		expect(JSON.stringify(server.requests.at(-1))).not.toContain("PROJECT_BETA");
	});
});
