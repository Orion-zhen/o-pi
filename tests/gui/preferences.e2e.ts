import { test, expect } from "./fixture.ts";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "jsonc-parser";
import { selectSetting, selectSettingsCategory } from "./settings-steps.ts";

for (const mode of ["web", "desktop"] as const) test.describe(mode, () => {
	test.use({ mode });
	test("偏好持久化、模块草稿和保存冲突", async ({ gui: { page }, workspace: { agentDir } }) => {
		const open = async () => {
			if ((page.viewportSize()?.width ?? 1200) < 768) await page.getByRole("button", { name: "菜单", exact: true }).click();
			await page.getByRole("button", { name: "设置", exact: true }).click();
		};
		const settings = page.getByRole("dialog", { name: "设置", exact: true });
		const file = path.join(agentDir, "configs", "gui.jsonc");
		const stored = async (): Promise<unknown> => parse(await readFile(file, "utf8"));
		await open();
		await selectSetting(page, "主题", "深色");
		await expect.poll(stored).toMatchObject({ theme: "dark" });
		await selectSettingsCategory(page, "交互");
		await selectSetting(page, "发送快捷键", "Enter（Shift + Enter 换行）");
		await expect.poll(stored).toMatchObject({ sendShortcut: "enter" });
		await page.reload();
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("/name 快捷键验证");
		await editor.press("Enter");
		await expect(page.locator(".topbar .session-name")).toHaveText("快捷键验证");
		await open();
		await selectSettingsCategory(page, "子代理");
		const parallel = settings.getByRole("spinbutton", { name: "最大并行任务数", exact: true });
		await parallel.fill("6");
		await selectSettingsCategory(page, "自动标题");
		await selectSettingsCategory(page, "子代理");
		await expect(parallel).toHaveValue("6");
		await settings.getByRole("button", { name: "关闭面板", exact: true }).click();
		await page.getByRole("button", { name: "继续编辑", exact: true }).click();
		await settings.getByRole("button", { name: "保存", exact: true }).click();
		const moduleFile = path.join(agentDir, "configs", "subagent.jsonc");
		await expect.poll(async () => parse(await readFile(moduleFile, "utf8"))).toMatchObject({ max_parallel_tasks: 6 });
		await expect(settings.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
		await writeFile(moduleFile, '{"max_parallel_tasks":3}');
		await parallel.fill("8");
		await settings.getByRole("button", { name: "保存", exact: true }).click();
		await expect(settings.getByRole("alert")).toContainText("保存失败");
		await expect(parallel).toHaveValue("8");
		expect(parse(await readFile(moduleFile, "utf8"))).toEqual({ max_parallel_tasks: 3 });
		await settings.getByRole("button", { name: "放弃修改", exact: true }).click();
	});
});
