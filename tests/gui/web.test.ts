import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { GuiHost } from "../../src/gui/host/host.ts";
import { startWebServer } from "../../src/web/server.ts";
import { useTempDir } from "../helpers/lifecycle.ts";
import type { GuiEvent } from "../../src/gui/contract.ts";

const temp = useTempDir("opi-web-boundary-");
let gui: GuiHost;
let server: Awaited<ReturnType<typeof startWebServer>>;
beforeEach(async () => {
	gui = new GuiHost();
	await writeFile(path.join(temp.path, "index.html"), "<!doctype html><title>GUI fixture</title>");
	server = await startWebServer(gui, { host: "127.0.0.1", port: 0, assets: temp.path });
});
afterEach(async () => {
	await server?.close();
	await gui?.dispose();
});
const headers = () => ({
	Origin: server.url,
	"Content-Type": "application/json",
});

describe("WebUI 的真实 HTTP/WebSocket 边界", () => {
	it("允许未加密的局域网监听", async () => {
		const lan = await startWebServer(gui, { host: "0.0.0.0", port: 0, assets: temp.path });
		try {
			const url = lan.url.replace("0.0.0.0", "127.0.0.1");
			expect((await fetch(url)).status).toBe(200);
			const response = await fetch(`${url}/api/action`, {
				method: "POST",
				headers: { Origin: url, "Content-Type": "application/json" },
				body: JSON.stringify({ action: "draft", text: "LAN" }),
			});
			expect(response.status).toBe(204);
			expect(gui.dialogs.draft).toBe("LAN");
		} finally {
			await lan.close();
		}
	});

	it("WebSocket 拒绝跨站连接", async () => {
		const ws = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, {
			headers: { Origin: "https://evil.example" },
		});
		const [error] = await once(ws, "error");
		expect(error.message).toContain("403");
	});
	it("免登录执行同源操作，拒绝跨站请求和静态目录穿越", async () => {
		const action = JSON.stringify({ action: "draft", text: "authorized" });
		const denied = await fetch(`${server.url}/api/action`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: action,
		});
		expect(denied.status).toBe(403);
		const crossSite = await fetch(`${server.url}/api/action`, {
			method: "POST",
			headers: { ...headers(), Origin: "https://evil.example" },
			body: action,
		});
		expect(crossSite.status).toBe(403);
		expect(gui.dialogs.draft).toBe("");
		const accepted = await fetch(`${server.url}/api/action`, { method: "POST", headers: headers(), body: action });
		expect(accepted.status).toBe(204);
		expect(gui.dialogs.draft).toBe("authorized");
		const page = await fetch(server.url);
		expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(page.headers.get("referrer-policy")).toBe("no-referrer");
		expect((await fetch(`${server.url}/%2e%2e%2fpackage.json`)).status).toBe(403);
	});

	it("WebSocket 免登录连接，断开不取消审批", async () => {
		const connect = async () => {
			const events: GuiEvent[] = [];
			const ws = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, {
				headers: { Origin: server.url },
			});
			ws.on("message", (value) => events.push(JSON.parse(value.toString()) as GuiEvent));
			await once(ws, "open");
			return { ws, events };
		};
		const first = await connect();
		const answer = gui.dialogs.ask("confirm", "允许操作吗？");
		await expect
			.poll(() => first.events.some((event) => event.type === "dialogs" && event.value.length === 1))
			.toBe(true);
		first.ws.close();
		await once(first.ws, "close");
		expect(gui.dialogs.list()).toHaveLength(1);
		const second = await connect();
		await expect
			.poll(() => second.events.some((event) => event.type === "dialogs" && event.value.length === 1))
			.toBe(true);
		const id = gui.dialogs.list()[0]?.id;
		const response = await fetch(`${server.url}/api/action`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ action: "dialog", id, value: "yes" }),
		});
		expect(response.status).toBe(204);
		expect(await answer).toBe("yes");
		second.ws.close();
		await once(second.ws, "close");
	});

	it("目录浏览检查来源，只列出服务端子目录", async () => {
		await mkdir(path.join(temp.path, "project"));
		const events: GuiEvent[] = [];
		const unsubscribe = gui.subscribe((event) => events.push(event));
		const body = JSON.stringify({ action: "directories", path: temp.path });
		const denied = await fetch(`${server.url}/api/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
		expect(denied.status).toBe(403);
		expect(events.some((event) => event.type === "directories")).toBe(false);
		const accepted = await fetch(`${server.url}/api/action`, { method: "POST", headers: headers(), body });
		expect(accepted.status).toBe(204);
		expect(events.find((event) => event.type === "directories")?.value.children).toEqual([{ name: "project", path: path.join(temp.path, "project") }]);
		unsubscribe();
	});

	it("拒绝非法参数", async () => {
		const response = await fetch(`${server.url}/api/action`, {
			method: "POST",
			headers: headers(),
			body: '{"action":"shell","command":"unrecognized"}',
		});
		expect(response.status).toBe(400);

	});
});
