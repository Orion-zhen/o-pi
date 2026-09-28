import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createServer } from "node:net";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixture.ts";
import { selectSettingsCategory } from "./settings-steps.ts";

let app: ElectronApplication | undefined;
let port: number;
const url = () => `http://127.0.0.1:${port}`;
const health = () => fetch(`${url()}/health`, { signal: AbortSignal.timeout(1000) }).then((response) => response.status, () => 0);

test.beforeEach(async ({ workspace: { home, agentDir } }, info) => {
	test.skip(info.project.name !== "desktop", "验证桌面宿主与浏览器共享后端");
	const listener = createServer();
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("缺少测试端口");
	port = address.port;
	await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
	await cp(path.resolve("dist/desktop/app"), path.join(home, "desktop-app"), { recursive: true });
	await writeFile(path.join(agentDir, "configs", "gui.jsonc"), JSON.stringify({ desktopWeb: { host: "127.0.0.1", port } }));
	await mkdir(path.join(agentDir, "extensions"));
	await writeFile(path.join(agentDir, "extensions", "web-confirm.ts"), `
		export default function(pi) {
			pi.registerCommand("web-confirm", { description: "验证跨端确认", async handler(_args, ctx) {
				if (await ctx.ui.confirm("跨端确认", "在浏览器中继续")) ctx.ui.notify("浏览器已确认");
			} });
		}
	`);
});
test.afterEach(async () => { await stopDesktop(); });

async function startDesktop(home: string, env: Record<string, string>, entry = path.join(home, "desktop-app")): Promise<Page> {
	app = await electron.launch({ args: [entry, "--no-sandbox"], cwd: home, env });
	const page = await app.firstWindow();
	await page.setViewportSize({ width: 1200, height: 820 });
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
	await expect.poll(() => page.evaluate(() => sessionStorage.getItem("opi.session"))).toBeTruthy();
	return page;
}
async function stopDesktop() {
	if (app) { await app.close(); app = undefined; }
}
function prompt(page: Page, text: string) {
	return page.evaluate(async (text) => {
		if (!window.opi) throw new Error("缺少桌面连接");
		await window.opi.send({ action: "prompt", text, images: [], behavior: "steer" }, sessionStorage.getItem("opi.session"));
	}, text);
}

test("默认不监听，在设置中开启后必须重启，关闭后也在重启时生效", async ({ workspace: { home, env }, page: remote }) => {
	const desktop = await startDesktop(home, env);
	expect(await health()).toBe(0);
	await desktop.getByRole("button", { name: "设置", exact: true }).click();
	await selectSettingsCategory(desktop, "桌面 Web 访问");
	const enabled = desktop.getByRole("checkbox", { name: "启用 Web 访问", exact: true });
	await expect(enabled).not.toBeChecked();
	await enabled.click();
	await expect(enabled).toBeChecked();
	await expect.poll(() => desktop.evaluate(async () => {
		const document = await window.opi?.query({ query: "guiConfig" }, null);
		return document?.state === "ready" && document.value.desktopWeb.enabled;
	})).toBe(true);
	expect(await health()).toBe(0);
	await stopDesktop();
	const restarted = await startDesktop(home, env);
	await expect.poll(health).toBe(200);
	await remote.goto(url());
	await expect(remote.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
	await restarted.getByRole("button", { name: "设置", exact: true }).click();
	await selectSettingsCategory(restarted, "桌面 Web 访问");
	const restartedEnabled = restarted.getByRole("checkbox", { name: "启用 Web 访问", exact: true });
	await restartedEnabled.click();
	await expect(restartedEnabled).not.toBeChecked();
	await expect.poll(() => restarted.evaluate(async () => {
		const document = await window.opi?.query({ query: "guiConfig" }, null);
		return document?.state === "ready" && document.value.desktopWeb.enabled;
	})).toBe(false);
	expect(await health()).toBe(200);
	await stopDesktop();
	await startDesktop(home, env);
	expect(await health()).toBe(0);
});

test("端口被占用时报告启动失败，桌面会话仍可执行", async ({ workspace: { home, env, agentDir } }) => {
	const listener = createServer();
	await new Promise<void>((resolve) => listener.listen(port, "127.0.0.1", resolve));
	try {
		await writeFile(path.join(agentDir, "configs", "gui.jsonc"), JSON.stringify({ desktopWeb: { enabled: true, host: "127.0.0.1", port } }));
		// 仅替换原生弹窗输出，仍由正式主进程接收后端的监听失败事件。
		const entry = path.join(home, "desktop-app", "capture-warning.mjs");
		await writeFile(entry, `
			import { dialog } from "electron";
			dialog.showMessageBox = async (options) => {
				process.env.OPI_TEST_WEB_WARNING = options.message + " " + options.detail;
				return { response: 0, checkboxChecked: false };
			};
			await import("./main.mjs");
		`);
		const desktop = await startDesktop(home, env, entry);
		const runningApp = app;
		if (!runningApp) throw new Error("缺少桌面应用");
		await expect.poll(() => runningApp.evaluate(() => process.env.OPI_TEST_WEB_WARNING)).toContain("EADDRINUSE");
		await prompt(desktop, "!printf desktop-still-usable");
		await expect(desktop.locator(".message.bashExecution").last()).toContainText("desktop-still-usable");
		await stopDesktop();
	} finally { await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())); }
});

test("双端共享运行输出和审批，浏览器刷新不停止任务，退出 Desktop 关闭服务", async ({ workspace: { home, env, agentDir }, page: remote }) => {
	await writeFile(path.join(agentDir, "configs", "gui.jsonc"), JSON.stringify({ desktopWeb: { enabled: true, host: "127.0.0.1", port } }));
	const desktop = await startDesktop(home, env);
	await expect.poll(health).toBe(200);
	await remote.goto(url());
	await expect.poll(() => remote.evaluate(() => sessionStorage.getItem("opi.session")))
		.toBe(await desktop.evaluate(() => sessionStorage.getItem("opi.session")));
	expect(await remote.evaluate(() => typeof window.opi)).toBe("undefined");
	const running = prompt(desktop, "!printf desktop-running; sleep 30");
	await expect(remote.locator(".live-output")).toContainText("desktop-running");
	await remote.reload();
	await expect(remote.locator(".live-output")).toContainText("desktop-running");
	await remote.getByRole("button", { name: "停止", exact: true }).click();
	await running;
	await expect(desktop.locator(".live-output")).toHaveCount(0);
	const editor = remote.getByRole("textbox", { name: "消息", exact: true });
	await editor.fill("!printf browser-finished");
	await editor.press("ControlOrMeta+Enter");
	await expect(desktop.locator(".message.bashExecution").last()).toContainText("browser-finished");
	await expect(remote.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
	const confirmation = prompt(desktop, "/web-confirm");
	await expect(desktop.getByRole("dialog", { name: "跨端确认", exact: true })).toBeVisible();
	await expect(remote.getByRole("dialog", { name: "跨端确认", exact: true })).toBeVisible();
	await remote.reload();
	await remote.getByRole("dialog", { name: "跨端确认", exact: true }).getByRole("button", { name: "确认", exact: true }).click();
	await confirmation;
	await expect(desktop.getByRole("dialog", { name: "跨端确认", exact: true })).toHaveCount(0);
	await expect(desktop.locator(".notices")).toContainText("浏览器已确认");
	await expect(remote.locator(".notices")).toContainText("浏览器已确认");
	await stopDesktop();
	await expect.poll(health).toBe(0);
});
