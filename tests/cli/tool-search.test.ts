import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useTempDir } from "../helpers/lifecycle.ts";
import { startModelServer, type ModelResponse } from "./model-server.ts";

const exec = promisify(execFile);
const cli = path.resolve(process.platform === "win32" ? "dist/tui/opi.exe" : "dist/tui/opi");
const temp = useTempDir("opi-tool-search-");
let server: Awaited<ReturnType<typeof startModelServer>>;
let responses: ModelResponse[];

beforeEach(async () => {
	responses = [];
	server = await startModelServer((request) => responses[request.messages.filter((message) => message.role === "tool").length]
		?? { text: "completed" });
});
afterEach(async () => { await server.close(); });

async function run(codemode = false) {
	const agentDir = path.join(temp.path, "agent");
	await mkdir(path.join(agentDir, "configs"), { recursive: true });
	await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "fixture", defaultModel: "test", defaultTools: ["tool_search", ...(codemode ? ["codemode"] : [])],
		compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture",
		models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	const extension = path.join(temp.path, "tools.mjs");
	await writeFile(extension, `
		export default function(pi) {
			for (const name of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
				pi.registerTool({
					name: "fixture_" + name, label: name, description: "Inspect fixture records.",
					exposure: "deferred", defaultActive: false,
					parameters: {type:"object",properties:{}},
					async execute() { return {content:[{type:"text",text:"record"}],details:{}}; }
				});
			}
		}
	`);
	const pending = exec(cli, ["--mode", "json", "--offline", "--approve", "--no-session", "-e", extension, "Inspect records"], {
		cwd: temp.path, timeout: 25_000, maxBuffer: 4 * 1024 * 1024,
		env: { PATH: process.env.PATH ?? "", HOME: temp.path, USERPROFILE: temp.path,
			PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", NODE_NO_WARNINGS: "1",
			...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }) },
	});
	pending.child.stdin?.end();
	const result = await pending;
	expect(result.stderr).toBe("");
	return server.requests;
}

it.each([
	{ args: { query: "fixture" }, names: ["alpha", "beta", "gamma"] },
	{ args: { query: "fixture", limit: 1 }, names: ["alpha"] },
	{ args: { query: "fixture_delta" }, names: ["delta"] },
	{ args: { query: "zzzzzz" }, names: [] },
])("tool_search 精简发现并加载：$args", async ({ args, names }) => {
	responses.push({ tool: "tool_search", args });
	const requests = await run();
	const definition = requests[0]?.tools?.find((tool) => tool.function.name === "tool_search")?.function;
	expect(definition?.description).toBe("Search unloaded tools and load matches for the next call.");
	expect(JSON.stringify(definition?.parameters)).toContain("Default 3.");
	const loaded = names.map((name) => "fixture_" + name);
	expect(requests[1]?.tools?.map((tool) => tool.function.name).filter((name) => name.startsWith("fixture_"))).toEqual(loaded);
	const output = requests[1]?.messages.find((message) => message.role === "tool")?.content;
	expect(output).toBe(loaded.length ? "Loaded: " + loaded.join(", ") : "No matches.");
});

it.each([
	{ query: " " },
	{ query: "fixture_alpha", limit: 0 },
	{ query: "fixture_alpha", limit: 1.5 },
])("tool_search 拒绝无效参数且不加载工具：%j", async (args) => {
	responses.push({ tool: "tool_search", args });
	const requests = await run();
	expect(requests[1]?.tools?.some((tool) => tool.function.name.startsWith("fixture_"))).toBe(false);
	const output = JSON.stringify(requests[1]?.messages.find((message) => message.role === "tool"));
	expect(output).toMatch(/query must not be empty|Validation failed/);
});

it("tool_search 保留已加载工具，后续搜索只加载剩余工具", async () => {
	responses.push({ tool: "tool_search", args: { query: "fixture" } }, { tool: "tool_search", args: { query: "fixture" } });
	const requests = await run();
	expect(requests[2]?.tools?.filter((tool) => tool.function.name.startsWith("fixture_"))).toHaveLength(5);
	expect(requests[2]?.messages.filter((message) => message.role === "tool").at(-1)?.content)
		.toBe("Loaded: fixture_delta, fixture_epsilon");
});

it("codemode 隐藏 tool_search，searchTools 仍返回可执行签名", async () => {
	responses.push({ tool: "codemode", args: { code: 'text(await searchTools("fixture", {limit:1}));' } },
		{ tool: "codemode", args: { code: "text(await tools.fixture_alpha({}));" } });
	const requests = await run(true);
	for (const request of requests) expect(request.tools?.map((tool) => tool.function.name)).not.toContain("tool_search");
	expect(JSON.stringify(requests[1]?.messages)).toContain("fixture_alpha(args:");
	expect(JSON.stringify(requests[2]?.messages)).toContain("record");
});
