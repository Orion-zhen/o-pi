import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { deferred } from "../helpers/async.ts";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GuiHost } from "../../src/gui/host/host.ts";
import type { GuiClient } from "../../src/gui/host/client.ts";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.ts";
import { startModelServer, type ModelResponse } from "../cli/model-server.ts";
import { readSnapshot } from "./read-snapshot.ts";
import { writeMcpFixture } from "./mcp-fixture.ts";

const temp = useTempDir("opi-gui-mcp-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_OFFLINE");
let host: GuiClient;
let model: Awaited<ReturnType<typeof startModelServer>>;
let response: ModelResponse;
let agentDir: string;
let mcpFile: string;
let fixture: string;
const probe = "mcp__fixture__probe";
const refresh = "mcp__fixture__refresh";
const prompt = (text: string) => ({ action: "prompt", text, images: [], behavior: "followUp" });
const tool = () => readSnapshot(host).tools.find((tool) => tool.name === probe);

beforeEach(async () => {
	setTestHome(temp.path);
	agentDir = path.join(temp.path, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	await mkdir(path.join(agentDir, "configs"), { recursive: true });
	await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
	await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
	response = { text: "done" };
	model = await startModelServer((request) => {
		const lastUser = request.messages.findLastIndex((message) => message.role === "user");
		return request.messages.slice(lastUser + 1).some((message) => message.role === "tool") ? { text: "done" } : response;
	});
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: model.url, api: "openai-completions", apiKey: "fixture",
		models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	fixture = await writeMcpFixture(temp.path);
	mcpFile = path.join(agentDir, "mcp.json");
	host = new GuiHost().createClient();
});
afterEach(async () => { await host?.host.dispose(); await model?.close(); });

async function start(exposure: string, codemode = true) {
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProjectTrust: "never", defaultProvider: "fixture", defaultModel: "test", defaultTools: codemode ? ["codemode"] : ["read"],
		compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(mcpFile, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture], exposure } } }));
	await host.host.start(temp.path);
	await expect.poll(tool).toMatchObject({ mcp: true, enabled: true, callable: true });
}

it.each(["codemode", "codemode-deferred", "deferred", "direct"])("%s 工具关闭后不声明、不被搜索发现，重新启用恢复调用", async (exposure) => {
	await start(exposure);
	const original = await readFile(mcpFile, "utf8");
	await host.dispatch({ action: "tool", name: probe, enabled: false });
	await host.dispatch({ action: "tool", name: refresh, enabled: false });
	expect(tool()).toMatchObject({ mcp: true, enabled: false, callable: false });
	expect(host.runtime.session.getAllTools().find((tool) => tool.name === probe)?.exposure).toBe("hidden");
	response = { tool: "codemode", args: { code: 'text(await searchTools("MCP_VISIBILITY", {namespace:"mcp__fixture"}));' } };
	await host.dispatch(prompt("搜索已关闭的 MCP 工具"));
	const request = model.requests[0];
	expect(JSON.stringify(request?.tools)).not.toContain(probe);
	expect(JSON.stringify(request?.tools)).not.toContain("MCP_VISIBILITY_NAMESPACE");
	const result = model.requests.at(-1)?.messages.findLast((message) => message.role === "tool");
	expect(JSON.stringify(result)).toContain("[]");
	expect(JSON.stringify(result)).not.toContain(probe);
	await host.dispatch({ action: "tool", name: "codemode", enabled: false });
	await host.dispatch({ action: "tool", name: "tool_search", enabled: true });
	expect(readSnapshot(host).tools.find((tool) => tool.name === "tool_search")).toMatchObject({ available: false, enabled: false });
	response = { text: "done" };
	await host.dispatch(prompt("没有候选工具时不能启用搜索"));
	expect(model.requests.at(-1)?.tools?.map((tool) => tool.function.name) ?? []).not.toContain("tool_search");
	expect(tool()).toMatchObject({ enabled: false, callable: false });
	await host.dispatch({ action: "tool", name: probe, enabled: true });
	response = { tool: probe, args: {} };
	await host.dispatch(prompt("不开启 codemode 也能直接使用勾选的工具"));
	expect(model.requests.at(-1)?.tools?.some((tool) => tool.function.name === probe)).toBe(true);
	expect(JSON.stringify(model.requests.at(-1)?.messages.findLast((message) => message.role === "tool"))).toContain("MCP_RESULT_probe");
	await host.dispatch({ action: "tool", name: "codemode", enabled: true });
	expect(tool()).toMatchObject({ enabled: true, callable: true });
	response = { tool: "codemode", args: { code: `text(await tools.${probe}({}));` } };
	await host.dispatch(prompt("调用重新启用的工具"));
	expect(JSON.stringify(model.requests.at(-1)?.messages.findLast((message) => message.role === "tool"))).toContain("MCP_RESULT_probe");
	expect(await readFile(mcpFile, "utf8")).toBe(original);
});

it("关闭选择在服务工具刷新、重载和会话恢复后保留，不影响新会话", async () => {
	await start("codemode");
	await host.dispatch(prompt("建立会话"));
	const firstId = readSnapshot(host).sessionId;
	const originalLeaf = host.runtime.session.sessionManager.getLeafId();
	const originalDescription = tool()?.description;
	await host.dispatch({ action: "tool", name: probe, enabled: false });
	const disabledLeaf = host.runtime.session.sessionManager.getLeafId();
	if (!originalLeaf || !disabledLeaf) throw new Error("缺少分支节点");
	response = { tool: "codemode", args: { code: `text(await tools.${refresh}({}));` } };
	await host.dispatch(prompt("刷新服务工具列表"));
	await expect.poll(() => tool()?.description).not.toBe(originalDescription);
	expect(tool()).toMatchObject({ enabled: false, callable: false });
	await host.dispatch({ action: "reload" });
	await expect.poll(tool).toMatchObject({ enabled: false, callable: false });
	await host.dispatch({ action: "navigate", entryId: originalLeaf, summarize: false });
	await expect.poll(tool).toMatchObject({ enabled: true, callable: true });
	await host.dispatch({ action: "navigate", entryId: disabledLeaf, summarize: false });
	await expect.poll(tool).toMatchObject({ enabled: false, callable: false });
	await host.dispatch({ action: "new" });
	await expect.poll(tool).toMatchObject({ enabled: true, callable: true });
	await host.dispatch({ action: "openSession", id: firstId });
	await expect.poll(tool).toMatchObject({ enabled: false, callable: false });
	const file = readSnapshot(host).sessionFile;
	if (!file) throw new Error("缺少会话文件");
	await host.host.dispose();
	host = new GuiHost().createClient();
	await host.host.start(temp.path);
	await host.dispatch({ action: "openSession", path: file });
	await expect.poll(tool).toMatchObject({ enabled: false, callable: false });
});

it.each(["codemode", "deferred"])("普通模式搜索 %s MCP 工具并直接调用，切换模式不改变加载选择", async (exposure) => {
	await start(exposure, false);
	const original = await readFile(mcpFile, "utf8");
	const active = () => host.runtime.session.getActiveToolNames();
	expect(active()).toContain("tool_search");
	expect(active()).not.toContain("codemode");
	const initialTools = active();
	response = { tool: "tool_search", args: { query: "MCP_VISIBILITY_probe", limit: 1 } };
	await host.dispatch(prompt("查找探测工具"));
	expect(model.requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(initialTools);
	expect(initialTools).not.toContain(probe);
	expect(JSON.stringify(model.requests[0]?.messages)).toContain("mcp__fixture");
	expect(JSON.stringify(model.requests[0]?.messages)).not.toContain("codemode scripts");
	expect(active()).toContain(probe);
	expect(model.requests.at(-1)?.tools?.some((tool) => tool.function.name === probe)).toBe(true);
	response = { tool: probe, args: {} };
	await host.dispatch(prompt("直接调用已加载工具"));
	expect(JSON.stringify(model.requests.at(-1)?.messages.findLast((message) => message.role === "tool"))).toContain("MCP_RESULT_probe");

	await host.dispatch({ action: "tool", name: "codemode", enabled: true });
	expect(active()).not.toContain("tool_search");
	expect(active()).toContain(probe);
	response = { tool: "codemode", args: { code: 'text(await describeNamespace("fixture")); text(await searchTools("MCP_VISIBILITY", {namespace:"fixture"}));' } };
	await host.dispatch(prompt("脚本搜索包含已加载和未加载工具"));
	const discovery = model.requests.at(-1)?.messages.findLast((message) => message.role === "tool");
	expect(JSON.stringify(discovery)).toContain("MCP_VISIBILITY_NAMESPACE");
	expect(JSON.stringify(discovery)).toContain(probe);
	expect(JSON.stringify(discovery)).toContain(refresh);
	const scriptedTools = model.requests.at(-1)?.tools?.map((tool) => tool.function.name) ?? [];
	expect(scriptedTools).toContain("codemode");
	expect(scriptedTools).not.toContain("tool_search");
	expect(scriptedTools.every((name) => host.runtime.session.getAllTools().find((tool) => tool.name === name)?.exposure === "model-only")).toBe(true);
	await host.dispatch({ action: "tool", name: "codemode", enabled: false });
	expect(active()).toEqual([...initialTools.filter((name) => name !== "tool_search"), probe, "tool_search"]);
	await host.dispatch({ action: "reload" });
	await expect.poll(() => active().includes("tool_search")).toBe(true);
	expect(active()).not.toContain("codemode");
	expect(await readFile(mcpFile, "utf8")).toBe(original);
});

it("父脚本仍在运行时保存子调用 SDK 耗时，完成并重载后仍可查看", async () => {
	await start("direct");
	const ended = deferred<void>();
	const continueParent = deferred<ModelResponse>();
	const waitModel = await startModelServer(() => continueParent.promise);
	try {
		// 第二个嵌套调用等待独立的本地 HTTP 响应，不阻塞普通聊天。
		const extensionDir = path.join(agentDir, "extensions");
		await mkdir(extensionDir);
		await writeFile(path.join(extensionDir, "hold.ts"), `export default (pi) => pi.registerTool({
			name:"hold", description:"Wait for local fixture", exposure:"codemode", parameters:{type:"object",properties:{}},
			execute:async (_id, _params, signal) => { const r=await fetch(${JSON.stringify(waitModel.url + "/chat/completions")}, {signal,method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"test",messages:[{role:"user",content:"hold"}],stream:true})}); await r.text(); return {content:[]}; }
		});`);
		await host.dispatch({ action: "reload" });
		await expect.poll(tool).toMatchObject({ available: true });
		const stop = host.runtime.session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.parentToolCallId && event.toolName === probe) ended.resolve();
		});
		response = { tool: "codemode", args: { code: `await tools.${probe}({}); await tools.hold({}); text("done");` } };
		const task = host.dispatch(prompt("查看子调用耗时"));
		try {
			await ended.promise;
			await expect.poll(() => readSnapshot(host).liveTools.find((tool) => tool.toolName === probe)).toMatchObject({ status: "ok", durationMs: expect.any(Number) });
		} finally { continueParent.resolve({ text: "done" }); stop(); await task; }
		const complete = readSnapshot(host).messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
		expect(complete).toMatchObject({ durationMs: expect.any(Number), nestedCalls: { calls: expect.arrayContaining([expect.objectContaining({ name: probe, durationMs: expect.any(Number) })]) } });
		await host.dispatch({ action: "reload" });
		expect(readSnapshot(host).messages.find((message) => message.role === "toolResult" && message.toolName === "codemode")).toEqual(complete);
	} finally { await waitModel.close(); }
});

it("脚本模式阻止模型绕过脚本直接调用 MCP，嵌套调用仍可执行", async () => {
	await start("direct");
	response = { tool: probe, args: {} };
	await host.dispatch(prompt("旧上下文请求直接调用"));
	const blocked = model.requests.at(-1)?.messages.findLast((message) => message.role === "tool");
	expect(JSON.stringify(blocked)).toContain("Codemode is active");
	expect(JSON.stringify(blocked)).not.toContain("MCP_RESULT_probe");
	response = { tool: "codemode", args: { code: `text(await tools.${probe}({}));` } };
	await host.dispatch(prompt("通过脚本执行"));
	expect(JSON.stringify(model.requests.at(-1)?.messages.findLast((message) => message.role === "tool"))).toContain("MCP_RESULT_probe");
});

it("普通模式的搜索入口在全部加载、隐藏和恢复后自动更新", async () => {
	await start("codemode", false);
	response = { tool: "tool_search", args: { query: "MCP_VISIBILITY" } };
	await host.dispatch(prompt("加载全部 MCP 工具"));
	expect(host.runtime.session.getActiveToolNames()).not.toContain("tool_search");
	await host.dispatch({ action: "tool", name: probe, enabled: false });
	await host.dispatch({ action: "tool", name: refresh, enabled: false });
	expect(host.runtime.session.getActiveToolNames()).not.toContain("tool_search");
	await host.dispatch({ action: "new" });
	await expect.poll(() => host.runtime.session.getActiveToolNames().includes("tool_search")).toBe(true);
	expect(host.runtime.session.getActiveToolNames()).not.toContain("codemode");
});

it("MCP 授权准备阶段的独立取消受 SDK 限制，关闭会话立即取消请求", async () => {
	const reached = deferred<void>();
	let url = "";
	let closed = false;
	const oauth = createServer((request, response) => {
		if (request.url === "/metadata") {
			reached.resolve();
			response.on("close", () => { closed = true; });
			return;
		}
		response.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${url}/resource"` });
		response.end();
	});
	try {
		await new Promise<void>((resolve) => oauth.listen(0, "127.0.0.1", resolve));
		const address = oauth.address();
		if (!address || typeof address === "string") throw new Error("缺少 OAuth 测试地址");
		url = `http://127.0.0.1:${address.port}`;
		await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", defaultTools: [], defaultProvider: "fixture", defaultModel: "test" }));
		await writeFile(mcpFile, JSON.stringify({ mcpServers: { fixture: { url: `${url}/mcp`, oauth: { authServerMetadataUrl: `${url}/metadata` } } } }));
		await host.host.start(temp.path);
		const login = host.dispatch(prompt("/mcp login fixture"));
		await reached.promise;
		await host.dispatch({ action: "cancelLogin" });
		expect(closed).toBe(false);
		expect(readSnapshot(host).commandRunning).toBe(true);
		const closing = host.host.dispose();
		await expect.poll(() => closed, { timeout: 1000 }).toBe(true);
		await closing;
		await login;
	} finally {
		oauth.closeAllConnections();
		await new Promise<void>((resolve, reject) => oauth.close((error) => error ? reject(error) : resolve()));
	}
}, 10_000);

it("配置编辑保留冲突检查，非法 JSON 可读取修复，不建立连接", async () => {
	const initial = await host.query({ query: "mcpConfig" });
	expect(initial).toMatchObject({ content: "" });
	const content = JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture], enabled: false } } });
	await host.dispatch({ action: "saveMcpConfig", original: "", content });
	expect(await host.query({ query: "mcpConfig" })).toMatchObject({ content });
	for (const invalid of ["[]", '{"mcpServers":[]}', '{"mcpServers":{"bad":true}}', "", "{",
		'{"mcpServers":{"bad":{"url":"ftp://example.com"}}}',
		'{"mcpServers":{"bad":{"command":"node","timeout":0}}}',
		'{"mcpServers":{"a-b":{"command":"node"},"a_b":{"command":"node"}}}',
		'{"mcpServers":{"bad":{"url":"https://example.com","headers":{"Authorization":"one","authorization":"two"}}}}',
		'{"mcpServers":{"bad":{"url":"https://example.com","oauth":{"clientRegistration":["cimd"]}}}}',
	]) {
		await expect(host.dispatch({ action: "saveMcpConfig", original: content, content: invalid })).rejects.toThrow();
		expect(await readFile(mcpFile, "utf8")).toBe(content);
	}
	await writeFile(mcpFile, "{");
	expect((await host.query({ query: "mcpConfig" })).content).toBe("{");
	await expect(host.dispatch({ action: "saveMcpConfig", original: content, content: "{}" })).rejects.toThrow();
	await host.dispatch({ action: "saveMcpConfig", original: "{", content: "{}" });
	expect(host.host.sessions.size).toBe(0);
});
