import { createServer } from "node:http";
import type { Socket } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelRequest, ModelResponse } from "../cli/model-server.ts";

export async function prepareRichTools(agentDir: string) {
	const server = createServer((request, response) => {
		if (new URL(request.url ?? "/", "http://fixture").pathname === "/search") {
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ web: { results: [
				{ title: "React 文档", url: "https://react.dev/learn", description: "React 组件与状态管理文档，了解如何组织交互界面。" },
				{ title: "聊天界面设计", url: "https://example.com/design", description: "展示工具活动与最终回复，保持流式进度清晰可读。" },
			] } }));
		} else {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>聊天界面设计</title></head><body><article><h1>聊天界面设计</h1><p>让用户专注于最终回复。</p>${"<p>模型执行任务时展示真实进度，完成后折叠处理过程。工具调用和结果在同一个位置更新，保留手动展开的状态。</p>".repeat(18)}<iframe src="https://example.com/embed"></iframe></article></body></html>`);
		}
	});
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
	server.on("connect", (_request, socket, head) => {
		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head.length > 0) socket.unshift(head);
		server.emit("connection", socket);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("缺少网页服务端口");
	const url = `http://127.0.0.1:${address.port}`;
	await writeFile(path.join(agentDir, "configs", "web-tools.jsonc"), JSON.stringify({
		network: { proxy: { enabled: true, http_proxy: url } },
		websearch: { brave_api: { enabled: true, endpoint: "http://search.example/search", api_key: "local-fixture" }, exa_api: { enabled: false }, tavily: { enabled: false }, duckduckgo_html: { enabled: false } },
		webfetch: { media: { mode: "off" } },
	}));
	await writeFile(path.join(agentDir, "configs", "subagent.jsonc"), JSON.stringify({ max_concurrency: 2 }));
	await mkdir(path.join(agentDir, "agents"), { recursive: true });
	await writeFile(path.join(agentDir, "agents", "gui-scout.md"), "---\nname: gui-scout\ndescription: GUI 进度验证\ntools: bash\nauto_confirm: true\nretries: 0\n---\n执行给定的验证任务。\n");
	const respond = (request: ModelRequest): ModelResponse | undefined => {
		const user = request.messages.findLast((message) => message.role === "user");
		const text = JSON.stringify(user?.content);
		const userIndex = request.messages.findLastIndex((message) => message.role === "user");
		const tools = request.messages.slice(userIndex + 1).filter((message) => message.role === "tool").length;
		if (text?.includes("GUI子任务")) {
			if (tools > 0) return { text: "**子代理检查完成**：状态与布局符合预期。" };
			return { tool: "bash", args: { command: `printf 'checking GUI\n'; sleep ${text.includes("布局") ? 4 : 2}; printf 'checked\n'` } };
		}
		if (!text?.includes("验证网页和子代理")) return undefined;
		if (tools === 0) return { text: "先查找网页参考，再并行检查布局与状态。", tool: "websearch", args: { query: "React 聊天界面设计", limit: 2 } };
		if (tools === 1) return { tool: "webfetch", args: { url: `${url}/article`, limit: 500 } };
		if (tools === 2) return { tool: "subagent", args: { tasks: [{ agent: "gui-scout", task: "GUI子任务：检查布局" }, { agent: "gui-scout", task: "GUI子任务：检查状态" }] } };
		return { text: "网页与子代理验证完成。" };
	};
	return { respond, close: () => new Promise<void>((resolve, reject) => { for (const socket of sockets) socket.destroy(); server.close((error) => error ? reject(error) : resolve()); }) };
}
