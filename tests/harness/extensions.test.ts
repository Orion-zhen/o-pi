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
import { extensions } from "../../src/harness/extensions.ts";
import { startModelServer, type ModelRequest, type ModelResponse } from "../cli/model-server.ts";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { ImageContent } from "@earendil-works/pi-ai";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.ts";

const temp = useTempDir("opi-sdk-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_OFFLINE");
let cwd: string;
let agentDir: string;
let runtime: AgentSessionRuntime | undefined;
let server: Awaited<ReturnType<typeof startModelServer>>;
let reply: (request: ModelRequest) => ModelResponse;

beforeEach(async () => {
	setTestHome(temp.path);
	cwd = path.join(temp.path, "workspace");
	agentDir = path.join(temp.path, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	await mkdir(cwd, { recursive: true });
	await mkdir(path.join(agentDir, "configs"), { recursive: true });
	reply = (request) => {
		const count = request.messages.filter((message) => message.role === "tool").length;
		if (count === 0) return { tool: "read", args: { path: "input.txt" } };
		if (count === 1) return { tool: "write", args: { path: "output.txt", content: "written through SDK\n" } };
		return { text: "SDK completed" };
	};
	server = await startModelServer((request) => reply(request));
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

async function createRuntime(noSkills = true) {
	runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: {
				extensionFactories: extensions,
				noSkills,
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
	it.each([true, false])("图片附件及 read 结果统一按模型处理，切换模型不改历史（autoResize：%s）", async (autoResize) => {
		const canvas = createCanvas(2400, 1200);
		canvas.getContext("2d").fillRect(0, 0, 2400, 1200);
		const bytes = canvas.toBuffer("image/png");
		await writeFile(path.join(cwd, "input.txt"), bytes);
		await writeFile(path.join(agentDir, "models.json"), "{}");
		await writeFile(path.join(agentDir, "models.jsonc"), JSON.stringify({ providers: {
			"sdk-fixture": { baseUrl: server.url, apiKey: "fixture", models: [
				{ id: "test", input: ["text", "image"], inputLimits: { images: { resize: { maxWidth: 2300, maxHeight: 2300 } } } },
				{ id: "small", input: ["text", "image"], inputLimits: { images: { resize: { maxWidth: 64, maxHeight: 64 } } } },
			] },
		} }), { mode: 0o600 });
		const host = await createRuntime();
		const selected = host.services.modelRuntime.getModel("sdk-fixture", "test");
		if (!selected) throw new Error("vision model missing");
		await host.session.setModel(selected);
		expect(host.session.model?.inputLimits).toEqual({ images: { resize: { maxWidth: 2300, maxHeight: 2300 } } });
		host.services.settingsManager.setImageAutoResize(autoResize);
		const image: ImageContent = { type: "image", data: bytes.toString("base64"), mimeType: "image/png" };
		await host.session.prompt("Read image", { images: [image] });
		const images = host.session.messages.flatMap((message) =>
			(message.role === "user" || message.role === "toolResult") && Array.isArray(message.content) ? message.content.filter((block): block is ImageContent => block.type === "image") : []);
		expect(images).toHaveLength(2);
		for (const block of images) {
			const decoded = await loadImage(Buffer.from(block.data, "base64"));
			expect(decoded.width).toBe(autoResize ? 2300 : 2400);
		}
		const history = structuredClone(host.session.sessionManager.getEntries());
		const small = host.services.modelRuntime.getModel("sdk-fixture", "small");
		if (!small) throw new Error("small model missing");
		await host.session.setModel(small);
		await host.session.prompt("Next image", { images: [image] });
		const next = host.session.messages.findLast((message) => message.role === "user");
		if (!next || !Array.isArray(next.content)) throw new Error("attachment missing");
		const attachment = next.content.find((block): block is ImageContent => block.type === "image");
		if (!attachment) throw new Error("attachment missing");
		expect((await loadImage(Buffer.from(attachment.data, "base64"))).width).toBe(autoResize ? 64 : 2400);
		expect(host.session.sessionManager.getEntries().slice(0, history.length)).toEqual(history);
	});

	it("skill 工具在 SDK 删除旧工具结果后重新披露正文", async () => {
		const skillDir = path.join(agentDir, "skills", "demo");
		await mkdir(skillDir, { recursive: true });
		await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: test skill\n---\nUnique skill body.\n");
		reply = (request) => {
			const lastUser = request.messages.findLastIndex((message) => message.role === "user");
			return request.messages.slice(lastUser + 1).some((message) => message.role === "tool")
				? { text: "loaded" } : { tool: "skill", args: { name: "demo" } };
		};
		const host = await createRuntime(false);
		await host.session.prompt("load demo");
		const manager = host.session.sessionManager;
		const original = manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "skill");
		if (!original || original.type !== "message" || original.message.role !== "toolResult") throw new Error("skill result missing");
		expect(JSON.stringify(original.message.content)).toContain("Unique skill body.");
		manager.appendContextEdit(original.id, null);
		host.session.refreshContext();
		await host.session.prompt("load demo again");
		const latest = host.session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "skill");
		if (latest?.role !== "toolResult") throw new Error("skill result missing");
		expect(JSON.stringify(latest.content)).toContain("Unique skill body.");
	});

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
