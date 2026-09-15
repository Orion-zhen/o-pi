import { writeFile } from "node:fs/promises";
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
	Authorization: `Bearer ${server.token}`,
	"Content-Type": "application/json",
});

describe("WebUI 的真实 HTTP/WebSocket 边界", () => {
	it("鉴权和来源检查先于执行，不向浏览器提供宽泛的文件服务器", async () => {
		const action = JSON.stringify({ action: "draft", text: "authorized" });
		const denied = await fetch(`${server.url}/api/action`, {
			method: "POST",
			headers: { Origin: server.url, "Content-Type": "application/json" },
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

	it("浏览器使用 HttpOnly Cookie，连接断开不取消审批", async () => {
		const auth = await fetch(`${server.url}/api/auth`, { method: "POST", headers: headers() });
		const cookie = auth.headers.get("set-cookie");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		const connect = async () => {
			const events: GuiEvent[] = [];
			const ws = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, {
				headers: { Origin: server.url, Cookie: cookie?.split(";")[0] ?? "" },
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

	it("拒绝非法参数和未加密的非回环监听", async () => {
		const response = await fetch(`${server.url}/api/action`, {
			method: "POST",
			headers: headers(),
			body: '{"action":"shell","command":"unrecognized"}',
		});
		expect(response.status).toBe(400);
		await expect(startWebServer(gui, { host: "0.0.0.0", port: 0, assets: temp.path })).rejects.toThrow("需要 --cert");
	});
});
