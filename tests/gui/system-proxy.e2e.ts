import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixture.ts";
import { startModelServer } from "../cli/model-server.ts";
import { startProxyFixture, socketToolExtension } from "./proxy-fixture.ts";

test.use({ mode: "desktop" });
test.beforeEach(({}, info) => { test.skip(info.project.name !== "desktop", "仅验证桌面网络栈"); });

for (const bypass of [false, true]) test.describe(bypass ? "系统代理绕过" : "系统代理", () => {
	let model: Awaited<ReturnType<typeof startModelServer>>;
	let proxy: Awaited<ReturnType<typeof startProxyFixture>>;
	test.beforeEach(async ({ workspace: { agentDir } }) => {
		await mkdir(path.join(agentDir, "agents"), { recursive: true });
		await writeFile(path.join(agentDir, "agents", "proxy-scout.md"), "---\nname: proxy-scout\ndescription: 代理验证\ntools: proxy_socket\nauto_confirm: true\nretries: 0\n---\n完成任务。\n");
		await writeFile(path.join(agentDir, "configs", "subagent.jsonc"), '{"timeout_ms":15000,"retries":0}');
		model = await startModelServer((request) => {
			const text = JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content);
			if (text.includes("系统代理子任务取消")) return { text: "", intervalMs: 50, chunks: Array.from({ length: 200 }, () => "子任务处理中") };
			if (text.includes("系统代理子任务")) {
				if (request.messages.at(-1)?.role !== "tool") return { tool: "proxy_socket", args: {} };
				return { text: JSON.stringify(request.messages.at(-1)?.content).includes("socket-ok") ? "子任务代理成功" : "子任务网络失败" };
			}
			if (text.includes("调用网页") && request.messages.at(-1)?.role !== "tool") return { tool: "webfetch", args: { url: "http://8.8.8.8/article" } };
			if (text.includes("调用子代理") && request.messages.at(-1)?.role !== "tool") {
				return { tool: "subagent", args: { tasks: [{ agent: "proxy-scout", task: text.includes("取消") ? "系统代理子任务取消" : "系统代理子任务" }] } };
			}
			return { text: "", intervalMs: 50, chunks: text.includes("取消")
				? Array.from({ length: 200 }, () => "流式输出中") : ["代理", "流式响应完成"] };
		});
		proxy = await startProxyFixture(model.url);
		await mkdir(path.join(agentDir, "extensions"), { recursive: true });
		await writeFile(path.join(agentDir, "extensions", "proxy-socket.ts"), socketToolExtension(bypass ? proxy.wsUrl : "ws://socket.invalid/"));
		await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
			defaultProjectTrust: "never", defaultProvider: "proxy-test", defaultModel: "test",
			compaction: { enabled: false }, retry: { enabled: false },
		}));
		await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "proxy-test": {
			api: "openai-completions", baseUrl: bypass ? model.url : "http://model.invalid/v1", apiKey: "proxy-test-token",
			models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		} } }));
	});
	test.afterEach(async () => { await proxy?.close(); await model?.close(); });

	test("模型流式请求遵循 Chromium 代理配置", async ({ gui: { app, page }, workspace: { agentDir } }) => {
		await app.evaluate(async ({ session }, { proxyRules, bypass }) => {
			await session.defaultSession.setProxy({ mode: "fixed_servers", proxyRules, proxyBypassRules: bypass ? "127.0.0.1" : "" });
		}, { proxyRules: bypass ? "http://127.0.0.1:1" : proxy.url, bypass });
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("验证系统代理");
		await editor.press("ControlOrMeta+Enter");
		await expect(page.locator(".reply-answer")).toContainText("代理流式响应完成");
		expect(model.requests.length).toBeGreaterThan(0);
		await editor.fill("调用子代理");
		await editor.press("ControlOrMeta+Enter");
		await expect.poll(() => model.requests.some((request) => Array.isArray(request.messages) && JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content).includes("系统代理子任务"))).toBe(true);
		await expect.poll(() => model.requests.some((request) => request.messages?.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("子任务代理成功")))).toBe(true);
		await expect(page.locator(".reply-answer").last()).toContainText("代理流式响应完成");
		expect(proxy.socketHeaders).toEqual(["Bearer websocket-test"]);
		if (!bypass) {
			await editor.fill("调用网页");
			await editor.press("ControlOrMeta+Enter");
			await expect.poll(() => proxy.systemPages).toBeGreaterThan(0);
			await expect(page.locator(".reply-answer").last()).toContainText("代理流式响应完成");
		}
		await writeFile(path.join(agentDir, "configs", "web-tools.jsonc"), JSON.stringify({ network: { proxy: { enabled: true, http_proxy: proxy.explicitUrl } } }));
		await editor.fill("调用网页覆盖代理");
		await editor.press("ControlOrMeta+Enter");
		await expect.poll(() => proxy.explicitPages).toBeGreaterThan(0);
		await expect.poll(() => model.requests.some((request) => request.messages?.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("explicit-web")))).toBe(true);
		await expect(page.locator(".reply-answer").last()).toContainText("代理流式响应完成");
		await editor.fill("调用子代理并取消");
		await editor.press("ControlOrMeta+Enter");
		await expect.poll(() => model.requests.some((request) => Array.isArray(request.messages) && JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content)?.includes("系统代理子任务取消"))).toBe(true);
		await page.getByRole("button", { name: "停止", exact: true }).click();
		await expect.poll(() => app.evaluate(({ app }) => app.getAppMetrics().some((metric) => metric.name === "opi-desktop subagent"))).toBe(false);
		await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
		await editor.fill("验证取消请求");
		await editor.press("ControlOrMeta+Enter");
		await expect(page.locator(".reply-answer").last()).toContainText("流式输出中");
		await page.getByRole("button", { name: "停止", exact: true }).click();
		await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
		await editor.fill("再次验证系统代理");
		await editor.press("ControlOrMeta+Enter");
		await expect(page.locator(".reply-answer").last()).toContainText("代理流式响应完成");
	});
});
