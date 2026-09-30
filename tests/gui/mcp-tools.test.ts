import { mkdir, readFile, writeFile } from "node:fs/promises";
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
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProjectTrust: "never", defaultProvider: "fixture", defaultModel: "test", defaultTools: ["codemode"],
		compaction: { enabled: false }, retry: { enabled: false },
	}));
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

async function start(exposure: string) {
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
	response = { tool: "tool_search", args: { query: "MCP_VISIBILITY", limit: 8 } };
	await host.dispatch(prompt("直接搜索已关闭的 MCP 工具"));
	expect(JSON.stringify(model.requests.at(-1)?.messages.findLast((message) => message.role === "tool"))).not.toContain(probe);
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

it("配置编辑保留冲突检查，非法 JSON 可读取修复，不建立连接", async () => {
	const initial = await host.query({ query: "mcpConfig" });
	expect(initial).toMatchObject({ content: "", errors: [] });
	const content = JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture], enabled: false } } });
	await host.dispatch({ action: "saveMcpConfig", original: "", content });
	expect(await host.query({ query: "mcpConfig" })).toMatchObject({ content, errors: [] });
	for (const invalid of ["[]", '{"mcpServers":[]}', '{"mcpServers":{"bad":true}}', "", "{"]) {
		await expect(host.dispatch({ action: "saveMcpConfig", original: content, content: invalid })).rejects.toThrow();
		expect(await readFile(mcpFile, "utf8")).toBe(content);
	}
	await writeFile(mcpFile, "{");
	expect((await host.query({ query: "mcpConfig" })).errors).not.toEqual([]);
	await expect(host.dispatch({ action: "saveMcpConfig", original: content, content: "{}" })).rejects.toThrow();
	await host.dispatch({ action: "saveMcpConfig", original: "{", content: "{}" });
	expect(host.host.sessions.size).toBe(0);
});
