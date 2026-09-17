import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	createAgentSessionFromServices, createAgentSessionServices, createAgentSessionRuntime, SessionManager,
	type AgentSessionRuntime, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import autoTitle from "../../../src/harness/extensions/auto-title.ts";
import { loadAutoTitleConfig } from "../../../src/harness/auto-title/config.ts";
import { startModelServer, type ModelRequest, type ModelResponse } from "../../cli/model-server.ts";
import { deferred } from "../../helpers/async.ts";
import { preserveEnv, setTestHome, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("opi-auto-title-session-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_AUTO_TITLE_CONFIG", "PI_OFFLINE", "PI_SUBAGENT_CHILD");
let runtime: AgentSessionRuntime | undefined;
let models: ModelRuntime;
let server: Awaited<ReturnType<typeof startModelServer>>;
let cwd: string;
let agentDir: string;
let systemPrompt: string;
let answerTitle: () => ModelResponse | Promise<ModelResponse>;
let titleRequests: ModelRequest[];

beforeEach(async () => {
	setTestHome(temp.path);
	cwd = path.join(temp.path, "workspace");
	agentDir = path.join(temp.path, ".pi", "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	delete process.env.PI_SUBAGENT_CHILD;
	process.env.PI_AUTO_TITLE_CONFIG = path.join(agentDir, "configs", "auto-title.jsonc");
	await mkdir(cwd, { recursive: true });
	await mkdir(path.join(agentDir, "configs"), { recursive: true });
	systemPrompt = (await loadAutoTitleConfig(cwd)).system_prompt;
	titleRequests = [];
	answerTitle = () => ({ text: "修复登录错误" });
	server = await startModelServer((request) => {
		if (request.messages.some((message) => (message.role === "system" || message.role === "developer") && message.content === systemPrompt)) {
			titleRequests.push(request);
			return answerTitle();
		}
		return { text: "主任务完成" };
	});
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "title-fixture", defaultModel: "plain", defaultThinkingLevel: "high",
		compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "title-fixture": {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture",
		models: ["plain", "minimal", "low", "vendor/model"].map((id) => ({
			id, name: id, reasoning: id !== "plain", input: ["text"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsReasoningEffort: true },
			...(id === "low" ? { thinkingLevelMap: { off: null, minimal: null } } : {}),
		})),
	} } }));
});

afterEach(async () => {
	await runtime?.dispose();
	runtime = undefined;
	await server?.close();
});

async function start(manager = SessionManager.create(cwd, path.join(temp.path, "sessions"))) {
	runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir,
			resourceLoaderOptions: {
				extensionFactories: [{ name: "auto-title", factory: autoTitle }],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			},
		});
		models = services.modelRuntime;
		return {
			...await createAgentSessionFromServices({ services, sessionManager, ...(sessionStartEvent ? { sessionStartEvent } : {}) }),
			services, diagnostics: services.diagnostics,
		};
	}, { cwd, agentDir, sessionManager: manager });
	await runtime.session.bindExtensions({ mode: "print" });
	return runtime.session;
}

async function config(value: object) {
	await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), JSON.stringify(value));
}

describe("共享 SDK 自动标题", () => {
	it("首条请求在后台生成并持久化，事件通知宿主且不污染对话", async () => {
		const reply = deferred<ModelResponse>();
		answerTitle = () => reply.promise;
		const current = await start();
		const names: Array<string | undefined> = [];
		current.subscribe((event) => { if (event.type === "session_info_changed") names.push(event.name); });
		await current.prompt("修复登录接口的 500 错误");
		await expect.poll(() => titleRequests.length).toBe(1);
		expect(current.sessionName).toBeUndefined();
		expect(JSON.stringify(current.messages)).toContain("主任务完成");
		reply.resolve({ text: ' “修复登录错误” ', thinking: "不应出现在标题里" });
		await expect.poll(() => current.sessionName).toBe("修复登录错误");
		expect(names).toEqual(["修复登录错误"]);
		expect(titleRequests[0]).toMatchObject({ messages: [
			{ role: "system", content: systemPrompt }, { role: "user", content: "修复登录接口的 500 错误" },
		] });
		expect(titleRequests[0]?.tools).toBeUndefined();
		expect(titleRequests[0]).not.toHaveProperty("reasoning_effort");
		expect(JSON.stringify(current.messages)).not.toContain("修复登录错误");
		const file = current.sessionFile;
		if (!file) throw new Error("Missing session file");
		expect(SessionManager.open(file).getSessionName()).toBe("修复登录错误");
		await current.prompt("接着优化查询");
		expect(titleRequests).toHaveLength(1);
	});

	it.each(["minimal", "low"])("所选模型使用最低思考等级 %s，保留主会话设置", async (id) => {
		await config({ model: `title-fixture/${id}` });
		const current = await start();
		const thinking = current.thinkingLevel;
		await current.prompt("处理登录问题");
		await expect.poll(() => current.sessionName).toBe("修复登录错误");
		expect(titleRequests[0]).toMatchObject({ model: id, reasoning_effort: id });
		expect(current.model?.id).toBe("plain");
		expect(current.thinkingLevel).toBe(thinking);
	});

	it("模型 ID 中的斜杠保留", async () => {
		await config({ model: "title-fixture/vendor/model" });
		const current = await start();
		await current.prompt("处理登录问题");
		await expect.poll(() => current.sessionName).toBe("修复登录错误");
		expect(titleRequests[0]).toMatchObject({ model: "vendor/model" });
	});

	it("同名模型按指定提供方选择", async () => {
		await config({ model: "other/plain" });
		const current = await start();
		models.registerProvider("other", {
			baseUrl: server.url, api: "openai-completions", apiKey: "fixture",
			models: [{
				id: "plain", name: "Other plain", reasoning: true, input: ["text"],
				contextWindow: 128000, maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: { supportsReasoningEffort: true },
			}],
		});
		await current.prompt("处理登录问题");
		await expect.poll(() => current.sessionName).toBe("修复登录错误");
		expect(titleRequests[0]).toMatchObject({ model: "plain", reasoning_effort: "minimal" });
		expect(current.model).toMatchObject({ provider: "title-fixture", id: "plain", reasoning: false });
	});

	it("当前模型支持思考时不继承主会话的高等级", async () => {
		const current = await start();
		const model = models.getModel("title-fixture", "low");
		if (!model) throw new Error("Missing model");
		await current.setModel(model);
		current.setThinkingLevel("high");
		await current.prompt("处理登录问题");
		await expect.poll(() => current.sessionName).toBe("修复登录错误");
		expect(titleRequests[0]).toMatchObject({ model: "low", reasoning_effort: "low" });
		expect(current.thinkingLevel).toBe("high");
	});

	it("生成期间手动改名保留用户名称", async () => {
		const reply = deferred<ModelResponse>();
		answerTitle = () => reply.promise;
		const current = await start();
		await current.prompt("处理登录问题");
		await expect.poll(() => titleRequests.length).toBe(1);
		current.setSessionName("手动名称");
		reply.resolve({ text: "过期标题" });
		await current.prompt("继续工作");
		expect(current.sessionName).toBe("手动名称");
		expect(titleRequests).toHaveLength(1);
	});

	it("关闭旧会话后生成结果不会写入新会话", async () => {
		const reply = deferred<ModelResponse>();
		answerTitle = () => reply.promise;
		const old = await start();
		await old.prompt("旧任务");
		await expect.poll(() => titleRequests.length).toBe(1);
		await runtime?.dispose();
		const current = await start();
		reply.resolve({ text: "旧标题" });
		answerTitle = () => ({ text: "新标题" });
		await current.prompt("新任务");
		await expect.poll(() => current.sessionName).toBe("新标题");
		expect(old.sessionName).toBeUndefined();
	});

	it.each(["empty", "network"])("%s 失败不影响主任务，不在后续轮次或恢复时重复生成", async (failure) => {
		answerTitle = () => {
			if (failure === "network") throw new Error("Model unavailable");
			return { text: "" };
		};
		const current = await start();
		await current.prompt("第一次请求");
		await expect.poll(() => titleRequests.length).toBe(1);
		await current.prompt("第二次请求");
		expect(current.sessionName).toBeUndefined();
		const file = current.sessionFile;
		if (!file) throw new Error("Missing session file");
		await runtime?.dispose();
		const resumed = await start(SessionManager.open(file));
		await resumed.prompt("恢复后继续");
		expect(titleRequests).toHaveLength(1);
	});

	it.each(["disabled", "named", "child", "extension"])("跳过 %s 会话或请求", async (kind) => {
		if (kind === "disabled") await config({ enabled: false });
		if (kind === "child") process.env.PI_SUBAGENT_CHILD = "1";
		const current = await start();
		if (kind === "named") current.setSessionName("已有标题");
		await current.prompt("处理登录问题", { source: kind === "extension" ? "extension" : "interactive" });
		expect(titleRequests).toHaveLength(0);
	});

	it("RPC 请求共享命名逻辑，已有标题重载后不再命名", async () => {
		const current = await start();
		await current.prompt("RPC 请求", { source: "rpc" });
		await expect.poll(() => current.sessionName).toBe("修复登录错误");
		await current.reload();
		await current.prompt("继续", { source: "rpc" });
		expect(titleRequests).toHaveLength(1);
	});

	it("生成期间重载取消旧请求，不给历史消息补标题", async () => {
		const reply = deferred<ModelResponse>();
		answerTitle = () => reply.promise;
		const current = await start();
		await current.prompt("旧任务");
		await expect.poll(() => titleRequests.length).toBe(1);
		await current.reload();
		reply.resolve({ text: "过期标题" });
		await current.prompt("继续");
		expect(current.sessionName).toBeUndefined();
		expect(titleRequests).toHaveLength(1);
	});

	it("自定义系统提示词生效，输入和标题按 Unicode 字符限制长度", async () => {
		systemPrompt = "只输出简短标题。";
		await config({ system_prompt: systemPrompt });
		answerTitle = () => ({ text: "🧪".repeat(60) + "\n更多内容" });
		const current = await start();
		await current.prompt("中".repeat(1999) + "🧪后续".repeat(100));
		await expect.poll(() => current.sessionName).toBe("🧪".repeat(50));
		expect(titleRequests[0]?.messages.at(-1)?.content).toBe("中".repeat(1999) + "🧪");
	});
});
