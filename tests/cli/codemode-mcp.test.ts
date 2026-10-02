import { createCanvas } from "@napi-rs/canvas";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useTempDir } from "../helpers/lifecycle.ts";
import { startModelServer, type ModelResponse } from "./model-server.ts";

const exec = promisify(execFile);
const cli = path.resolve(process.platform === "win32" ? "dist/tui/opi.exe" : "dist/tui/opi");
const temp = useTempDir("opi-codemode-mcp-");
let server: Awaited<ReturnType<typeof startModelServer>>;
let responses: ModelResponse[];

beforeEach(async () => {
	responses = [];
	server = await startModelServer((request) => responses[request.messages.filter((message) => message.role === "tool").length]
		?? { text: "completed" });
});
afterEach(async () => { await server.close(); });

it.each([
	{ exposure: "codemode", inlineBudget: 3000, inline: false },
	{ exposure: "direct", inlineBudget: 3000, inline: true },
	{ exposure: "direct", inlineBudget: 0, inline: false },
])("codemode 按需声明 MCP 类型并通过脚本转交图片：$exposure / $inlineBudget", async ({ exposure, inlineBudget, inline }) => {
	const agentDir = path.join(temp.path, "agent");
	await mkdir(path.join(agentDir, "configs"), { recursive: true });
	await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "fixture", defaultModel: "test", defaultTools: ["codemode"],
		codemode: { inlineBudget }, compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture",
		models: [{ id: "test", name: "Test", reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	const imagePath = path.join(temp.path, "sample.png");
	const canvas = createCanvas(2, 2);
	canvas.getContext("2d").fillRect(0, 0, 2, 2);
	const image = canvas.toBuffer("image/png");
	await writeFile(imagePath, image);

	// 只模拟外部 MCP 服务，发现、schema 包装、工具执行和图片转交走正式 SDK。
	const mcpPath = path.join(temp.path, "images.mjs");
	await writeFile(mcpPath, `
		import { createInterface } from "node:readline";
		import { readFileSync } from "node:fs";
		for await (const line of createInterface({ input: process.stdin })) {
			const request = JSON.parse(line);
			if (!("id" in request)) continue;
			let result;
			switch (request.method) {
				case "initialize": result = { protocolVersion: request.params.protocolVersion, capabilities: {tools:{}}, serverInfo: {name:"images",version:"1"} }; break;
				case "ping": result = {}; break;
				case "tools/list": result = { tools: [{ name:"read_image", description:"Read a PNG image.", inputSchema:{type:"object",properties:{path:{type:"string",description:"PNG file path."}},required:["path"],additionalProperties:false} }] }; break;
				case "tools/call": result = { content: [{type:"image",data:readFileSync(request.params.arguments.path).toString("base64"),mimeType:"image/png"}] }; break;
				default: throw new Error(request.method);
			}
			process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result}) + "\\n");
		}
	`);
	await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
		images: { command: process.execPath, args: [mcpPath], exposure },
	} }));
	if (!inline) responses.push({ tool: "codemode", args: { code: 'text(await searchTools("PNG image", {namespace:"mcp__images", limit:1}));' } });
	responses.push({ tool: "codemode", args: {
		code: `const r = await tools.mcp__images__read_image({path:${JSON.stringify(imagePath)}}); for (const block of r.content) if (block.type === "image") image(block);`,
	} });
	const pending = exec(cli, ["--mode", "json", "--offline", "--approve", "--no-session", "Read image"], {
		cwd: temp.path, timeout: 25_000, maxBuffer: 4 * 1024 * 1024,
		env: { PATH: process.env.PATH ?? "", HOME: temp.path, USERPROFILE: temp.path,
			PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", NODE_NO_WARNINGS: "1",
			...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }) },
	});
	pending.child.stdin?.end();
	const result = await pending;
	expect(result.stderr).toBe("");
	const description = server.requests[0]?.tools?.find((tool) => tool.function.name === "codemode")?.function.description;
	expect(description).toContain("describeNamespace(name)");
	expect(description).toContain("image(dataUrlOrImageBlock)");
	expect(description).toContain("`models`");
	if (inline) {
		expect(description).toContain("mcp__images__read_image(args:");
		expect(description).toContain("CallToolResult");
	} else {
		expect(description).not.toContain("CallToolResult");
		for (const request of server.requests) {
			expect(request.tools?.map((tool) => tool.function.name)).not.toContain("tool_search");
			expect(request.tools?.find((tool) => tool.function.name === "codemode")?.function.description).toBe(description);
		}
		expect(description).not.toContain("mcp__images__read_image(args:");
		expect(description).toContain("searchTools");
		const discovery = server.requests[1]?.messages.find((message) => message.role === "tool");
		expect(JSON.stringify(discovery)).toContain("mcp__images__read_image(args:");
	}
	expect(JSON.stringify(server.requests.at(-1)?.messages)).toContain(`data:image/png;base64,${image.toString("base64")}`);
	expect(result.stdout).not.toContain("Script failed");
});
