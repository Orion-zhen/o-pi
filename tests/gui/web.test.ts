import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { GuiHost } from "../../src/gui/host/host.ts";
import type { GuiClient } from "../../src/gui/host/client.ts";
import { startWebServer } from "../../src/web/server.ts";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.ts";
import type { GuiEvent } from "../../src/gui/contract.ts";
import { GuiReceiver, type GuiDelivery } from "../../src/gui/sync.ts";

const temp = useTempDir("opi-web-boundary-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_OFFLINE");
let gui: GuiHost;
let local: GuiClient;
let peer: Awaited<ReturnType<typeof connect>>;
let server: Awaited<ReturnType<typeof startWebServer>>;

async function connect(url: string) {
	const events: GuiEvent[] = [];
	const ws = new WebSocket(`${url.replace("http", "ws")}/api/events?session=${local.snapshot().sessionId}`, { headers: { Origin: url } });
	const receiver = new GuiReceiver();
	ws.on("message", (value) => {
		const delivery = JSON.parse(value.toString()) as GuiDelivery;
		events.push(...delivery.events.map((event) => receiver.accept(event)));
		ws.send(JSON.stringify({ ack: delivery.id }));
	});
	await once(ws, "open");
	await expect.poll(() => events.some((event) => event.type === "client")).toBe(true);
	const ready = events.find((event) => event.type === "client");
	if (!ready || ready.type !== "client") throw new Error("缺少连接标识");
	return { ws, events, id: ready.id };
}

beforeEach(async () => {
	setTestHome(temp.path);
	const agent = path.join(temp.path, "agent");
	process.env.PI_CODING_AGENT_DIR = agent;
	process.env.PI_OFFLINE = "1";
	await mkdir(path.join(agent, "configs"), { recursive: true });
	await writeFile(path.join(agent, "settings.json"), '{"defaultProjectTrust":"never","defaultProvider":"web-fixture","defaultModel":"test"}');
	await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: {
		"web-fixture": { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture", models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
	} }));
	await writeFile(path.join(agent, "configs", "discord-presence.jsonc"), '{"enabled":false}');
	const cwd = path.join(temp.path, "workspace");
	await mkdir(cwd);
	gui = new GuiHost();
	local = gui.createClient();
	await gui.start(cwd);
	await writeFile(path.join(temp.path, "index.html"), "<!doctype html><title>GUI fixture</title>");
	server = await startWebServer(gui, { host: "127.0.0.1", port: 0, assets: temp.path });
	peer = await connect(server.url);
});
afterEach(async () => { await server?.close(); await gui?.dispose(); });
const headers = () => ({ Origin: server.url, "Content-Type": "application/json", "X-Opi-Client": peer.id });
const body = (value: unknown, sessionId: string | null = local.snapshot().sessionId) => JSON.stringify({ value, sessionId });

describe("WebUI 的真实 HTTP/WebSocket 边界", () => {
	it.each([
		["logo.svg", "image/svg+xml"], ["favicon.svg", "image/svg+xml"], ["favicon.ico", "image/x-icon"],
		["apple-touch-icon.png", "image/png"], ["site.webmanifest", "application/manifest+json"],
	])("按正确类型提供品牌资源 %s", async (filename, contentType) => {
		const source = new URL(`../../src/gui/ui/public/${filename}`, import.meta.url);
		await copyFile(source, path.join(temp.path, filename));
		const response = await fetch(`${server.url}/${filename}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(contentType);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(source));
		const head = await fetch(`${server.url}/${filename}`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-type")).toBe(contentType);
		expect(await head.text()).toBe("");
	});

	it("允许未加密的局域网监听", async () => {
		const lan = await startWebServer(gui, { host: "0.0.0.0", port: 0, assets: temp.path });
		try {
			const url = lan.url.replace("0.0.0.0", "127.0.0.1");
			const client = await connect(url);
			expect((await fetch(url)).status).toBe(200);
			const response = await fetch(`${url}/api/action`, {
				method: "POST", headers: { ...headers(), Origin: url, "X-Opi-Client": client.id }, body: body({ action: "draft", text: "LAN" }),
			});
			expect(response.status).toBe(204);
			expect([...gui.clients].find((entry) => entry.id === client.id)?.readDraft(local.snapshot().sessionId)).toBe("LAN");
			expect(local.readDraft(local.snapshot().sessionId)).toBe("");
		} finally { await lan.close(); }
	});
	it("WebSocket 拒绝跨站连接", async () => {
		const ws = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, { headers: { Origin: "https://evil.example" } });
		const [error] = await once(ws, "error");
		expect(error.message).toContain("403");
	});
	it("同源操作绑定连接与目标会话，拒绝跨站请求和静态目录穿越", async () => {
		const action = body({ action: "draft", text: "authorized" });
		const denied = await fetch(`${server.url}/api/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: action });
		expect(denied.status).toBe(403);
		const crossSite = await fetch(`${server.url}/api/action`, { method: "POST", headers: { ...headers(), Origin: "https://evil.example" }, body: action });
		expect(crossSite.status).toBe(403);
		expect([...gui.clients].find((entry) => entry.id === peer.id)?.readDraft(local.snapshot().sessionId)).toBe("");
		const accepted = await fetch(`${server.url}/api/action`, { method: "POST", headers: headers(), body: action });
		expect(accepted.status).toBe(204);
		expect([...gui.clients].find((entry) => entry.id === peer.id)?.readDraft(local.snapshot().sessionId)).toBe("authorized");
		const unbound = await fetch(`${server.url}/api/action`, { method: "POST", headers: { ...headers(), "X-Opi-Client": "missing" }, body: action });
		expect(unbound.status).toBe(400);
		const page = await fetch(server.url);
		expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(page.headers.get("referrer-policy")).toBe("no-referrer");
		expect((await fetch(`${server.url}/%2e%2e%2fpackage.json`)).status).toBe(403);
	});

	it("WebSocket 断开不取消审批，重连只消费一次", async () => {
		const answer = local.dialogs.ask("confirm", "允许操作吗？");
		await expect.poll(() => peer.events.some((event) => event.type === "dialogs" && event.value.length === 1)).toBe(true);
		peer.ws.close();
		await once(peer.ws, "close");
		expect(local.dialogs.list()).toHaveLength(1);
		peer = await connect(server.url);
		expect(peer.events.some((event) => event.type === "dialogs" && event.value.length === 1)).toBe(true);
		const id = local.dialogs.list()[0]?.id;
		const respond = () => fetch(`${server.url}/api/action`, { method: "POST", headers: headers(), body: body({ action: "dialog", id, value: "yes" }) });
		expect((await respond()).status).toBe(204);
		expect(await answer).toBe("yes");
		expect((await respond()).status).toBe(400);
	});

	it("目录查询检查来源，并发请求各自返回对应目录而非广播", async () => {
		const root = path.join(temp.path, "directories");
		const project = path.join(root, "project");
		await mkdir(project, { recursive: true });
		const denied = await fetch(`${server.url}/api/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body({ query: "directories", path: root }) });
		expect(denied.status).toBe(403);
		const responses = await Promise.all([root, project].map((path) => fetch(`${server.url}/api/query`, {
			method: "POST", headers: headers(), body: body({ query: "directories", path }),
		})));
		for (const response of responses) expect(response.status).toBe(200);
		expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
			expect.objectContaining({ children: [{ name: "project", path: project }] }), expect.objectContaining({ children: [] }),
		]);
	});
	it.each([
		["action", { action: "prompt", text: "缺少必需参数" }],
		["query", { query: "directories", path: 42 }],
	])("%s 入口拒绝非法参数", async (endpoint, value) => {
		const response = await fetch(`${server.url}/api/${endpoint}`, { method: "POST", headers: headers(), body: body(value) });
		expect(response.status).toBe(400);
	});
	it("不接受省略目标会话的旧请求", async () => {
		const response = await fetch(`${server.url}/api/action`, { method: "POST", headers: headers(), body: JSON.stringify({ action: "abort" }) });
		expect(response.status).toBe(400);
	});
});
