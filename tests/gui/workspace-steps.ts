import { expect, type Page } from "@playwright/test";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { storeSession } from "./session-fixture.ts";
import type { prepareHistory } from "./session-steps.ts";
import { clickRowAction, expectRowActionOverlay } from "./row-action-layout.ts";

export async function exerciseWorkspaceRemoval(page: Page, fixture: Awaited<ReturnType<typeof prepareHistory>>) {
	const phone = (page.viewportSize()?.width ?? 1200) < 768;
	const missing = path.join(path.dirname(fixture.cwd), "失效目录", "需要移除的长路径工作区".repeat(4));
	const file = await storeSession({ ...fixture, cwd: missing, name: "移除后保留的会话" });
	await rm(path.dirname(missing), { recursive: true });
	for (let index = 0; index < 10; index++)
		await storeSession({ ...fixture, cwd: path.join(path.dirname(fixture.cwd), `列表滚动测试-${index}`), name: `滚动会话 ${index}` });
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
	await expect(option).toContainText("目录不存在");
	const remove = page.getByRole("button", { name: `移除工作区 ${missing}`, exact: true });
	await expectRowActionOverlay(page, page.locator(".workspace-option-row").filter({ has: remove }));
	await remove.hover();
	const layout = await remove.evaluate((button) => {
		const list = button.closest(".workspace-list");
		const icon = button.querySelector("svg");
		if (!(list instanceof HTMLElement) || !icon) throw new Error("缺少工作区操作区");
		const rect = button.getBoundingClientRect();
		const iconRect = icon.getBoundingClientRect();
		const listRect = list.getBoundingClientRect();
		const font = Number.parseFloat(getComputedStyle(button).fontSize);
		return {
			roomy: rect.width >= iconRect.width + font * 1.9 && rect.height >= iconRect.height + font * 1.9,
			gap: listRect.left + list.clientWidth - rect.right,
			font,
			scrollable: list.scrollHeight > list.clientHeight,
			fits: listRect.left >= 0 && listRect.right <= innerWidth,
		};
	});
	expect(layout.roomy).toBe(true);
	expect(layout.gap).toBeGreaterThanOrEqual(layout.font * 0.9);
	expect(layout.scrollable).toBe(true);
	expect(layout.fits).toBe(true);
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
	expect(await readFile(file, "utf8")).toContain("移除后保留的会话");
	await page.reload();
	await expect(page.locator(".session-heading button")).toHaveText("当前 GUI 会话");
	await picker();
	await expect(option).toHaveCount(0);
	await page.keyboard.press("Escape");
	if (phone) await page.getByRole("button", { name: "关闭菜单", exact: true }).click();
	await mkdir(missing, { recursive: true });
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("/resume");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	const panel = page.getByRole("dialog", { name: "会话列表", exact: true });
	await panel.getByRole("button", { name: "移除后保留的会话", exact: true }).click();
	await expect(page.locator(".session-heading button")).toHaveText("移除后保留的会话");
	await picker();
	await expect(option).toBeEnabled();
	await expect(remove).toHaveCount(0);
	await page.getByRole("option", { name: fixture.cwd, exact: true }).click();
	if (phone) await page.getByRole("button", { name: "菜单", exact: true }).click();
	await page.getByRole("region", { name: "历史会话", exact: true }).getByRole("button", { name: "当前 GUI 会话", exact: true }).click();
	await expect(page.locator(".session-heading button")).toHaveText("当前 GUI 会话");
}
