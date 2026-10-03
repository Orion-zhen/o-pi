import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { cp } from "node:fs/promises";
import path from "node:path";
import { test as base, expect } from "./workspace.ts";

export const test = base.extend<{ gui: { app: ElectronApplication; page: Page } }>({
	gui: async ({ workspace: { home, cwd, env }, viewport }, use) => {
		const entry = path.join(home, "desktop-app");
		await cp(path.resolve("dist/desktop/app"), entry, { recursive: true });
		const app = await electron.launch({ args: [entry, "--no-sandbox"], cwd, env, acceptDownloads: true });
		try {
			const page = await app.firstWindow();
			if (viewport) await page.setViewportSize(viewport);
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			// 桌面从 HOME 启动，通过公开操作进入测试工作区。
			await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
			await expect.poll(() => page.evaluate(() => sessionStorage.getItem("opi.session"))).toBeTruthy();
			const previous = await page.evaluate(async (cwd) => {
				if (!window.opi) throw new Error("缺少桌面连接");
				const id = sessionStorage.getItem("opi.session");
				await window.opi.send({ action: "workspace", path: cwd }, null);
				return id;
			}, cwd);
			// 请求响应先于界面消费 selected，等待会话切换后再输入。
			await page.waitForFunction((id) => sessionStorage.getItem("opi.session") !== id, previous);
			await expect(page.locator(".workspace-select").first()).toContainText(path.basename(cwd));
			await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
			await use({ app, page });
			expect(errors).toEqual([]);
		} finally {
			try {
				// 失败时可能留下未保存草稿，销毁窗口以跳过 beforeunload。
				await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); });
			} finally { await app.close(); }
		}
	},
});
export { expect };
