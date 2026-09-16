import { expect, type Page } from "@playwright/test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { storeSession } from "./session-fixture.ts";
import { exerciseSessionHeading } from "./session-heading-steps.ts";
import { clickRowAction, expectRowActionOverlay } from "./row-action-layout.ts";

export async function prepareHistory(home: string, cwd: string) {
	const agentDir = path.join(home, ".pi", "agent");
	const provider = "gui-test";
	for (let index = 1; index <= 7; index++) {
		await storeSession({
			cwd,
			agentDir,
			provider,
			name: `历史会话 ${index}`,
			timestamp: Date.UTC(2026, 0, index),
		});
	}
	const other = path.join(home, "client", "workspace");
	await storeSession({
		cwd: other,
		agentDir,
		provider,
		name: "另一工作区会话",
		text: "来自另一个工作区",
		timestamp: Date.UTC(2026, 0, 2),
	});
	await storeSession({
		cwd: path.join(home, "docs"),
		agentDir,
		provider,
		name: "文档整理",
		timestamp: Date.UTC(2026, 0, 1),
	});
	return { cwd, other, agentDir, provider };
}

export async function chooseWorkspace(page: Page, directory: string) {
	const phone = (page.viewportSize()?.width ?? 1200) < 768;
	if (phone && !(await page.getByRole("dialog", { name: "工作空间导航", exact: true }).count()))
		await page.getByRole("button", { name: "菜单", exact: true }).click();
	await page.getByRole("combobox", { name: "工作区", exact: true }).first().click();
	await page.getByRole("textbox", { name: "筛选工作区", exact: true }).fill(directory);
	await page.getByRole("option", { name: directory, exact: true }).click();
	if (phone) await page.getByRole("button", { name: "菜单", exact: true }).click();
}

export async function exerciseHistory(
	page: Page,
	fixture: Awaited<ReturnType<typeof prepareHistory>>,
	screenshotName: string,
) {
	const phone = (page.viewportSize()?.width ?? 1200) < 768;
	const openSidebar = async () => {
		if (phone) await page.getByRole("button", { name: "菜单", exact: true }).click();
	};
	const history = page.getByRole("region", { name: "历史会话", exact: true });
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("/name 当前 GUI 会话");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".session-heading button")).toHaveText("当前 GUI 会话");
	await exerciseSessionHeading(page);
	await openSidebar();
	const footer = page.locator(phone ? ".mobile-sidebar .sidebar-footer" : ".sidebar .sidebar-footer");
	await expect(footer.getByRole("button")).toHaveCount(5);
	await expect(footer.getByRole("button").nth(2)).toHaveAttribute("aria-label", "模型");
	await expect(history.getByRole("button", { name: "另一工作区会话", exact: true })).toHaveCount(0);
	await expect(history.getByRole("button", { name: /^其他工作区/ })).toHaveCount(0);
	await expect(history.locator(".workspace-sessions")).toHaveCount(0);
	await expect(history.getByRole("button", { name: /显示更多/ })).toHaveCount(0);
	await history.getByRole("button", { name: "历史会话 1", exact: true }).scrollIntoViewIfNeeded();
	await expect(history.getByRole("button", { name: "历史会话 1", exact: true })).toBeVisible();
	const oldRow = history.locator(".history-session-row").filter({ has: page.getByRole("button", { name: "历史会话 1", exact: true }) });
	await expectRowActionOverlay(page, oldRow);
	await oldRow.getByRole("button", { name: "重命名会话 历史会话 1", exact: true }).click();
	const rename = history.getByRole("textbox", { name: "会话名称", exact: true });
	await expect(rename).toBeFocused();
	await expect(page.getByRole("dialog", { name: "重命名会话", exact: true })).toHaveCount(0);
	await rename.fill("取消历史改名");
	await rename.press("Escape");
	await expect(history.getByRole("button", { name: "历史会话 1", exact: true })).toBeVisible();
	await oldRow.getByRole("button", { name: "重命名会话 历史会话 1", exact: true }).click();
	await rename.fill("   ");
	await rename.press("Enter");
	await expect(history.getByRole("button", { name: "历史会话 1", exact: true })).toBeVisible();
	await oldRow.getByRole("button", { name: "重命名会话 历史会话 1", exact: true }).click();
	await rename.fill("重命名的历史会话");
	await rename.press("Enter");
	await expect(history.getByRole("button", { name: "重命名的历史会话", exact: true })).toBeVisible();
	await expect(page.locator(".session-heading button")).toHaveText("当前 GUI 会话");
	await clickRowAction(history.getByRole("button", { name: "重命名会话 当前 GUI 会话", exact: true }));
	await rename.fill("侧栏当前名称");
	await history.getByRole("heading").click();
	await expect(page.locator(".session-heading button")).toHaveText("侧栏当前名称");
	await clickRowAction(history.getByRole("button", { name: "重命名会话 侧栏当前名称", exact: true }));
	await rename.fill("当前 GUI 会话");
	await rename.press("Enter");
	await expect(page.locator(".session-heading button")).toHaveText("当前 GUI 会话");
	await chooseWorkspace(page, fixture.other);
	await expect(history.getByRole("button", { name: "当前 GUI 会话", exact: true })).toHaveCount(0);
	await history.getByRole("button", { name: "另一工作区会话", exact: true }).click();
	if (phone) await expect(page.getByRole("dialog", { name: "工作空间导航", exact: true })).toHaveCount(0);
	await expect(page.locator(".session-heading button")).toHaveText("另一工作区会话");
	await expect(page.locator(".message.user")).toContainText("来自另一个工作区");
	await openSidebar();
	await expect(page.getByRole("combobox", { name: "工作区", exact: true })).toHaveAttribute("title", fixture.other);
	await expect(history.getByRole("button", { name: "另一工作区会话", exact: true })).toHaveAttribute(
		"aria-current",
		"page",
	);
	await expect(history.getByRole("button", { name: /^其他工作区/ })).toHaveCount(0);
	await chooseWorkspace(page, fixture.cwd);
	await history.getByRole("button", { name: "当前 GUI 会话", exact: true }).click();
	await expect(page.locator(".session-heading button")).toHaveText("当前 GUI 会话");
	await expect(page.getByRole("main").getByText("GUI 验证完成：图片、代码搜索和文件写入。", { exact: true })).toBeVisible();
	await openSidebar();
	await history.locator(".history-scroll").evaluate((element) => element.scrollTo({ top: 0 }));
	await page.mouse.move((page.viewportSize()?.width ?? 1200) - 4, 70);
	await page.screenshot({
		animations: "disabled",
		path: path.join(process.cwd(), "dist", `gui-history-${screenshotName}.png`),
	});

	const external = await storeSession({ ...fixture, name: "TUI 外部新增" });
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(history.getByRole("button", { name: "TUI 外部新增", exact: true })).toBeVisible();
	await expect(page.getByRole("dialog", { name: "会话列表", exact: true })).toHaveCount(0);
	SessionManager.open(external).appendSessionInfo("TUI 外部改名");
	await history.getByRole("button", { name: "刷新会话", exact: true }).click();
	await expect(history.getByRole("button", { name: "TUI 外部改名", exact: true })).toBeVisible();
	await rm(external);
	await history.getByRole("button", { name: "刷新会话", exact: true }).click();
	await expect(history.getByRole("button", { name: "TUI 外部改名", exact: true })).toHaveCount(0);
	if (phone) await page.getByRole("button", { name: "关闭菜单", exact: true }).click();
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("/resume");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	const panel = page.getByRole("dialog", { name: "会话列表", exact: true });
	await expect(panel).toBeVisible();
	await expect(panel.getByRole("button", { name: "重命名的历史会话", exact: true })).toBeVisible();
	await panel.getByRole("button", { name: "关闭面板", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
