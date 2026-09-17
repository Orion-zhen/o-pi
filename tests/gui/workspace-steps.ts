import { expect, type Page } from "@playwright/test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { storeSession } from "./session-fixture.ts";
import type { prepareHistory } from "./session-steps.ts";
import { clickRowAction } from "./row-actions.ts";

export async function exerciseWorkspaceRemoval(page: Page, fixture: Awaited<ReturnType<typeof prepareHistory>>) {
	const phone = (page.viewportSize()?.width ?? 1200) < 768;
	const missing = path.join(path.dirname(fixture.cwd), "失效目录", "待移除项目");
	const file = await storeSession({ ...fixture, cwd: missing, name: "待移除的会话" });
	await rm(path.dirname(missing), { recursive: true });
	const navigation = page.getByRole("dialog", { name: "工作空间导航", exact: true });
	const picker = async () => {
		if (phone && !await navigation.count()) await page.getByRole("button", { name: "菜单", exact: true }).click();
		await page.getByRole("region", { name: "历史会话", exact: true }).getByRole("button", { name: "刷新会话", exact: true }).click();
		await page.getByRole("combobox", { name: "工作区", exact: true }).click();
	};
	await picker();
	await expect(page.getByRole("button", { name: `移除工作区 ${fixture.cwd}`, exact: true })).toHaveCount(0);
	const option = page.getByRole("option", { name: missing, exact: true });
	await expect(option).toBeDisabled();
	const remove = page.getByRole("button", { name: `移除工作区 ${missing}`, exact: true });
	await clickRowAction(remove);
	const confirm = page.getByRole("button", { name: `确认移除工作区 ${missing}`, exact: true });
	await expect(confirm).toBeVisible();
	await confirm.press("Escape");
	await expect(remove).toBeVisible();
	await clickRowAction(remove);
	await page.getByRole("textbox", { name: "筛选工作区", exact: true }).click();
	await expect(confirm).toHaveCount(0);
	await clickRowAction(remove);
	await confirm.click();
	await expect(option).toHaveCount(0);
	await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
	await page.reload();
	await expect(page.locator(".session-heading button")).toHaveText("当前 GUI 会话");
	await picker();
	await expect(option).toHaveCount(0);
	await page.keyboard.press("Escape");
	if (phone) await page.getByRole("button", { name: "关闭菜单", exact: true }).click();
}
