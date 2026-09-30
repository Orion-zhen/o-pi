import { _electron as electron } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixture.ts";

test.use({ mode: "desktop" });
test.beforeEach(async ({ workspace: { agentDir, home } }, info) => {
	test.skip(info.project.name !== "desktop", "仅验证桌面进程协议");
	await mkdir(path.join(agentDir, "extensions"), { recursive: true });
	await writeFile(path.join(agentDir, "extensions", "protocol.ts"), `
		import { appendFile } from "node:fs/promises";
		export default function (pi) {
			pi.registerCommand("protocol-dialog", { description: "协议验证", async handler(_args, ctx) {
				const value = await ctx.ui.input("协议确认");
				if (value) ctx.ui.notify("已确认: " + value);
			} });
			pi.on("session_shutdown", async () => {
				await appendFile(${JSON.stringify(path.join(home, "shutdown.log"))}, "released\\n");
			});
		}
	`);
});

test("交互等待期间可并发查询，失败请求不影响后续操作", async ({ gui: { page }, workspace: { cwd } }) => {
	const operation = page.evaluate(async () => {
		if (!window.opi) throw new Error("缺少桌面连接");
		await window.opi.send({ action: "prompt", text: "/protocol-dialog", images: [], behavior: "steer" }, sessionStorage.getItem("opi.session"));
		return "completed";
	});
	const dialog = page.getByRole("dialog", { name: "协议确认", exact: true });
	await expect(dialog).toBeVisible();
	const results = await page.evaluate(async (cwd) => {
		if (!window.opi) throw new Error("缺少桌面连接");
		return Promise.allSettled([
			window.opi.query({ query: "directories", path: cwd }, null),
			window.opi.send({ action: "workspace", path: cwd + "/missing" }, null),
			window.opi.query({ query: "guiConfig" }, null),
		]).then((results) => results.map((result) => result.status));
	}, cwd);
	expect(results).toEqual(["fulfilled", "rejected", "fulfilled"]);
	await dialog.getByLabel("输入内容").fill("通信正常");
	await dialog.getByRole("button", { name: "提交", exact: true }).click();
	expect(await operation).toBe("completed");
	await expect(page.locator(".notices")).toContainText("已确认: 通信正常");
	const invalid = await page.evaluate(async () => {
		if (!window.opi) throw new Error("缺少桌面连接");
		const bridge = window.opi;
		const missingTarget: Promise<unknown> = Reflect.apply(bridge.send, bridge, [{ action: "new" }, undefined]);
		const invalidAction: Promise<unknown> = Reflect.apply(bridge.send, bridge, [{ action: "new", unexpected: true }, null]);
		return Promise.all([missingTarget.catch(String), invalidAction.catch(String)]);
	});
	expect(invalid[0]).toBeTruthy();
	expect(invalid[1]).toBeTruthy();
});

test("后端异常退出会拒绝等待中的请求和新请求", async ({ gui: { app, page } }) => {
	const operation = page.evaluate(async () => {
		if (!window.opi) throw new Error("缺少桌面连接");
		return window.opi.send({ action: "prompt", text: "/protocol-dialog", images: [], behavior: "steer" }, sessionStorage.getItem("opi.session"))
			.then(() => "completed", String);
	});
	await expect(page.getByRole("dialog", { name: "协议确认", exact: true })).toBeVisible();
	await app.evaluate(({ app, dialog }) => {
		dialog.showErrorBox = (title, content) => { process.env.OPI_TEST_BACKEND_EXIT = `${title}: ${content}`; };
		const backend = app.getAppMetrics().find((metric) => metric.name === "opi-desktop SDK");
		if (!backend) throw new Error("缺少 SDK 后端");
		process.kill(backend.pid, "SIGKILL");
	});
	expect(await operation).toBeTruthy();
	await expect.poll(() => app.evaluate(() => process.env.OPI_TEST_BACKEND_EXIT)).toContain("SDK 后端已退出");
	const result = await page.evaluate(async () => {
		if (!window.opi) throw new Error("缺少桌面连接");
		return window.opi.query({ query: "guiConfig" }, null).then(() => "completed", String);
	});
	expect(result).toBeTruthy();
});

test("应用退出等待会话释放后结束后端", async ({ workspace: { cwd, env, home } }) => {
	const app = await electron.launch({ args: [path.resolve("dist/desktop/app"), "--no-sandbox"], cwd, env });
	const child = app.process();
	try {
		const page = await app.firstWindow();
		await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
		await page.evaluate(async (cwd) => {
			if (!window.opi) throw new Error("缺少桌面连接");
			await window.opi.send({ action: "workspace", path: cwd }, null);
		}, cwd);
		await writeFile(path.join(home, "shutdown.log"), "");
		const closed = app.waitForEvent("close");
		await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
		await closed;
		expect(await readFile(path.join(home, "shutdown.log"), "utf8")).toContain("released\n");
		expect(child.exitCode).toBe(0);
	} finally {
		if (child.exitCode === null && child.signalCode === null) await app.close();
	}
});
