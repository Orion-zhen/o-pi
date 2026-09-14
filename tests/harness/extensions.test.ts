import {
	SessionManager,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createAgentSessionFromServices,
	type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extensions } from "../../src/harness/extensions.js";
import { startModelServer } from "../cli/model-server.js";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("opi-sdk-");
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
	await mkdir(path.join(agentDir, "configs"), { recursive: true });
	server = await startModelServer((request) => {
		const count = request.messages.filter((message) => message.role === "tool").length;
		if (count === 0) return { tool: "read", args: { path: "input.txt" } };
		if (count === 1) return { tool: "write", args: { path: "output.txt", content: "written through SDK\n" } };
		return { text: "SDK completed" };
	});
	await writeFile(path.join(cwd, "input.txt"), "SDK fixture\n");
	await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
	await writeFile(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "sdk-fixture",
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
				"sdk-fixture": {
					baseUrl: server.url,
					api: "openai-completions",
					apiKey: "fixture",
					models: [
						{
							id: "test",
							name: "SDK fixture",
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
});

afterEach(async () => {
	try {
		await runtime?.dispose();
	} finally {
		runtime = undefined;
		await server.close();
	}
});

async function createRuntime() {
	runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: {
				extensionFactories: extensions,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		return {
			...await createAgentSessionFromServices({
				services,
				sessionManager,
				...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
			}),
			services,
			diagnostics: services.diagnostics,
		};
	}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
	await runtime.session.bindExtensions({ mode: "print" });
	return runtime;
}

describe("通过原生 SDK 复用 harness 业务扩展", () => {
	it("不启动 CLI 或终端即可订阅事件并完成真实文件工具回路", async () => {
		const host = await createRuntime();
		expect(host.diagnostics).toEqual([]);
		const completed: string[] = [];
		const unsubscribe = host.session.subscribe((event) => {
			if (event.type === "tool_execution_end") completed.push(event.toolName);
		});
		try {
			await host.session.prompt("Read input and write output");
		} finally {
			unsubscribe();
		}
		expect(completed).toEqual(["read", "write"]);
		expect(await readFile(path.join(cwd, "output.txt"), "utf8")).toBe("written through SDK\n");
		expect(JSON.stringify(host.session.messages)).toContain("SDK completed");
	});

	it("会话替换重建工作目录服务，并让应用重新绑定会话", async () => {
		const host = await createRuntime();
		const oldSession = host.session;
		const oldServices = host.services;
		const rebound: string[] = [];
		host.setRebindSession(async (session) => {
			await session.bindExtensions({ mode: "print" });
			rebound.push(session.sessionManager.getSessionId());
		});
		expect(await host.newSession()).toEqual({ cancelled: false });
		expect(host.session).not.toBe(oldSession);
		expect(host.services).not.toBe(oldServices);
		expect(host.cwd).toBe(cwd);
		expect(host.session.model).toMatchObject({ provider: "sdk-fixture", id: "test" });
		expect(rebound).toEqual([host.session.sessionManager.getSessionId()]);
		await host.session.prompt("Run after session replacement");
		expect(await readFile(path.join(cwd, "output.txt"), "utf8")).toBe("written through SDK\n");
	});
});
