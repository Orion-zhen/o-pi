import { expect, type Page } from "@playwright/test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { storeSession } from "./session-fixture.ts";

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
	const currentGroup = () =>
		history
			.locator(".workspace-sessions")
			.filter({ has: page.getByRole("button", { name: `工作区 ${fixture.cwd}`, exact: true }) });
	const otherGroup = () =>
		history
			.locator(".workspace-sessions")
			.filter({ has: page.getByRole("button", { name: `工作区 ${fixture.other}`, exact: true }) });
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("/name 当前 GUI 会话");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".session-heading strong")).toHaveText("当前 GUI 会话");
	await openSidebar();
	const navigation = page.getByRole("navigation", { name: "工作空间导航", exact: true });
	for (const name of ["会话", "会话树", "工具", "模型", "技能"])
		await expect(navigation.getByRole("button", { name, exact: true })).toHaveText(name);
	const positions = await navigation
		.getByRole("button")
		.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
	expect(positions.every((top, index) => index === 0 || top > (positions[index - 1] ?? top))).toBe(true);
	await expect(otherGroup()).toHaveCount(0);
	await expect(history.getByRole("button", { name: /^其他工作区/ })).toHaveAttribute("aria-expanded", "false");
	await expect(history.locator(".workspace-sessions").first()).toHaveAttribute("data-current", "true");
	await expect(currentGroup().getByRole("button", { name: `工作区 ${fixture.cwd}`, exact: true })).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	await expect(currentGroup().getByRole("button", { name: "历史会话 1", exact: true })).toHaveCount(0);
	await currentGroup()
		.getByRole("button", { name: /显示更多/ })
		.click();
	await expect(currentGroup().getByRole("button", { name: "历史会话 1", exact: true })).toBeVisible();
	await history.getByRole("button", { name: /^其他工作区/ }).click();
	await expect(otherGroup().getByRole("button", { name: `工作区 ${fixture.other}`, exact: true })).toHaveAttribute(
		"aria-expanded",
		"false",
	);
	await expect(currentGroup().locator(".workspace-label small")).toHaveText(fixture.cwd);
	await expect(otherGroup().locator(".workspace-label small")).toHaveText(fixture.other);
	await otherGroup()
		.getByRole("button", { name: `工作区 ${fixture.other}`, exact: true })
		.click();
	await otherGroup().getByRole("button", { name: "另一工作区会话", exact: true }).click();
	if (phone) await expect(page.getByRole("dialog", { name: "工作空间导航", exact: true })).toHaveCount(0);
	await expect(page.locator(".session-heading small")).toHaveText(fixture.other);
	await expect(page.locator(".message.user")).toContainText("来自另一个工作区");
	await openSidebar();
	await expect(
		history
			.locator(".workspace-sessions")
			.first()
			.getByRole("button", { name: `工作区 ${fixture.other}`, exact: true }),
	).toHaveAttribute("aria-expanded", "true");
	await expect(otherGroup().getByRole("button", { name: "另一工作区会话", exact: true })).toHaveAttribute(
		"aria-current",
		"page",
	);
	await expect(history.getByRole("button", { name: /^其他工作区/ })).toHaveAttribute("aria-expanded", "false");
	await history.getByRole("button", { name: /^其他工作区/ }).click();
	const original = currentGroup().getByRole("button", { name: `工作区 ${fixture.cwd}`, exact: true });
	if ((await original.getAttribute("aria-expanded")) === "false") await original.click();
	await currentGroup().getByRole("button", { name: "当前 GUI 会话", exact: true }).click();
	await expect(page.locator(".session-heading small")).toHaveText(fixture.cwd);
	await expect(page.getByText("GUI 验证完成：图片、代码搜索和文件写入。", { exact: true })).toBeVisible();
	await openSidebar();
	const collapseHistory = currentGroup().getByRole("button", { name: "收起", exact: true });
	if (await collapseHistory.isVisible()) await collapseHistory.click();
	await history.evaluate((element) => element.closest(".sidebar-scroll")?.scrollTo({ top: 0 }));
	await page.mouse.move((page.viewportSize()?.width ?? 1200) - 4, 70);
	await page.screenshot({
		animations: "disabled",
		path: path.join(process.cwd(), "dist", `gui-history-${screenshotName}.png`),
	});

	const external = await storeSession({ ...fixture, name: "TUI 外部新增" });
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(currentGroup().getByRole("button", { name: "TUI 外部新增", exact: true })).toBeVisible();
	await expect(page.getByRole("dialog", { name: "会话列表", exact: true })).toHaveCount(0);
	SessionManager.open(external).appendSessionInfo("TUI 外部改名");
	await history.getByRole("button", { name: "刷新会话", exact: true }).click();
	await expect(currentGroup().getByRole("button", { name: "TUI 外部改名", exact: true })).toBeVisible();
	await rm(external);
	await history.getByRole("button", { name: "刷新会话", exact: true }).click();
	await expect(currentGroup().getByRole("button", { name: "TUI 外部改名", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "会话", exact: true }).click();
	const panel = page.getByRole("dialog", { name: "会话列表", exact: true });
	await expect(panel).toBeVisible();
	await expect(panel.getByRole("button", { name: "历史会话 1", exact: true })).toBeVisible();
	await panel.getByRole("button", { name: "关闭面板", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
