import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	createAgentSessionFromServices, createAgentSessionServices, createAgentSessionRuntime, SessionManager,
	type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it } from "vitest";
import messagePerformance from "../../../src/harness/extensions/message-performance.ts";
import { getAssistantPerformance, type AssistantPerformance } from "../../../src/harness/message-performance/types.ts";
import { startModelServer } from "../../cli/model-server.ts";
import { preserveEnv, setTestHome, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("opi-performance-session-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_OFFLINE");
let cwd: string;
let agentDir: string;
let runtime: AgentSessionRuntime | undefined;
let server: Awaited<ReturnType<typeof startModelServer>> | undefined;

beforeEach(async () => {
	setTestHome(temp.path);
	cwd = path.join(temp.path, "workspace");
	agentDir = path.join(temp.path, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	server = await startModelServer((request) => request.messages.filter((message) => message.role === "user").length === 1
		? { text: "Hello world", chunks: ["Hello", " world"], intervalMs: 20 }
		: { text: "Buffered response" });
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "fixture", defaultModel: "test", defaultThinkingLevel: "off",
		compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture",
		models: [{
			id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}],
	} } }));
});

afterEach(async () => {
	await runtime?.dispose();
	runtime = undefined;
	await server?.close();
	server = undefined;
});

async function start(manager = SessionManager.create(cwd, path.join(temp.path, "sessions"))) {
	runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir,
			resourceLoaderOptions: {
				noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
				extensionFactories: [{ name: "message-performance", factory: messagePerformance }],
			},
		});
		return {
			...await createAgentSessionFromServices({ services, sessionManager, ...(sessionStartEvent ? { sessionStartEvent } : {}) }),
			services, diagnostics: services.diagnostics,
		};
	}, { cwd, agentDir, sessionManager: manager });
	await runtime.session.bindExtensions({ mode: "print" });
	return runtime.session;
}

it("正文速度先于宿主事件发布，跨请求独立，并随 SDK 会话落盘恢复", async () => {
	const session = await start();
	const observed: Array<AssistantPerformance | undefined> = [];
	const partials: Array<AssistantPerformance | undefined> = [];
	session.subscribe((event) => {
		if (event.type !== "message_update" || event.message.role !== "assistant" || event.assistantMessageEvent.type !== "text_end") return;
		observed.push(getAssistantPerformance(event.message));
		partials.push(getAssistantPerformance(event.assistantMessageEvent.partial));
	});
	await session.prompt("first");
	await session.prompt("second");

	expect(observed).toHaveLength(2);
	expect(observed[0]?.bodyTps[0]).toBeGreaterThan(0);
	expect(observed[0]?.ttftWithoutThinkingMs).toBeGreaterThanOrEqual(0);
	expect(observed[1]?.bodyTps[0]).toBeNull();
	expect(partials).toEqual(observed);
	expect(session.messages.filter((message) => message.role === "assistant").map(getAssistantPerformance)).toEqual(observed);

	const file = session.sessionFile;
	if (!file) throw new Error("会话未保存");
	await runtime?.dispose();
	runtime = undefined;
	const restored = await start(SessionManager.open(file));
	expect(restored.messages.filter((message) => message.role === "assistant").map(getAssistantPerformance)).toEqual(observed);
});
