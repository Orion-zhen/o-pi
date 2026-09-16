import { expect, type Page } from "@playwright/test";
import path from "node:path";

export async function exercisePanels(page: Page, screenshotName: string) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const sidebar = page.getByRole("complementary", { name: "会话信息", exact: true });
	const viewport = page.viewportSize();
	const draft = "保留未发送草稿";
	await editor.fill(draft);
	await expect(sidebar).toBeVisible();
	await expect(sidebar.getByRole("tab", { name: "会话树", exact: true })).toHaveAttribute("aria-selected", "true");
	await expect(sidebar).toContainText("暂无可展示的消息");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	for (const [title, heading] of [["会话统计", "上下文窗口"], ["遥测", "工具运行概览"]] as const) {
		await sidebar.getByRole("tab", { name: title, exact: true }).click();
		await expect(sidebar.getByRole("heading", { name: heading, exact: true })).toBeVisible();
		await expect(editor).toBeEditable();
		await expect(editor).toHaveValue(draft);
	}
	await page.screenshot({ animations: "disabled", path: path.resolve("dist", `gui-session-sidebar-${screenshotName}.png`) });
	await expect(sidebar.getByRole("button", { name: "刷新会话信息", exact: true })).toHaveCount(0);
	await expect(sidebar.getByRole("button", { name: "收起会话信息", exact: true })).toHaveCount(0);
	await expect(sidebar.getByRole("tab", { name: "遥测", exact: true })).toHaveAttribute("aria-selected", "true");

	for (const size of [{ width: 1200, height: 820 }, { width: 820, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 640, height: 360 }]) {
		await page.setViewportSize(size);
		await expect(sidebar).toBeVisible();
		await expect(editor).toBeInViewport();
		await expect(page.getByRole("button", { name: "发送", exact: true })).toBeInViewport();
		const layout = await page.evaluate(() => {
			const chat = document.querySelector(".main-panel")?.getBoundingClientRect();
			const side = document.querySelector(".session-sidebar")?.getBoundingClientRect();
			if (!chat || !side) throw new Error("缺少分屏区域");
			return {
				overlap: chat.right > side.left + 1 && chat.bottom > side.top + 1,
				overflow: document.documentElement.scrollWidth > innerWidth,
			};
		});
		expect(layout).toEqual({ overlap: false, overflow: false });
	}
	if (viewport) await page.setViewportSize(viewport);

	const tools = page.getByRole("button", { name: /^工具：已启用/ });
	const count = Number(await tools.innerText());
	await tools.click();
	const toolPanel = page.getByRole("dialog", { name: "工具选择", exact: true });
	await expect(toolPanel).toBeVisible();
	const checkbox = toolPanel.locator("label").filter({ has: page.getByText("websearch", { exact: true }) }).getByRole("checkbox");
	await expect(checkbox).toBeChecked();
	await checkbox.click();
	await toolPanel.getByRole("button", { name: "关闭面板" }).click();
	await expect(tools).toHaveText(String(count - 1));
	await expect(sidebar).toBeVisible();
	await expect(sidebar.getByRole("tab", { name: "遥测", exact: true })).toHaveAttribute("aria-selected", "true");
	await tools.click();
	await checkbox.click();
	await page.keyboard.press("Escape");
	await expect(tools).toHaveText(String(count));
	await expect(editor).toBeFocused();
	await page.getByRole("button", { name: "收起会话信息", exact: true }).click();
	await expect(sidebar).toHaveCount(0);
	await page.getByRole("button", { name: "展开会话信息", exact: true }).click();
	await expect(sidebar.getByRole("tab", { name: "遥测", exact: true })).toHaveAttribute("aria-selected", "true");
	await page.getByRole("button", { name: "收起会话信息", exact: true }).click();

	for (const title of ["系统提示词", "命令帮助", "导入会话"]) {
		await page.getByRole("button", { name: "会话操作", exact: true }).click();
		await expect(page.getByRole("menuitem", { name: "重载资源", exact: true })).toHaveCount(0);
		await expect(page.getByRole("menuitem", { name: "会话统计", exact: true })).toHaveCount(0);
		await page.getByRole("menuitem", { name: title, exact: true }).click();
		const dialog = page.getByRole("dialog", { name: title, exact: true });
		await expect(dialog).toBeVisible();
		await expect(dialog).toHaveCSS("position", "static");
		await dialog.getByRole("button", { name: "关闭面板", exact: true }).click();
	}
	const phone = (page.viewportSize()?.width ?? 1200) < 768;
	for (const title of ["认证", "套餐用量"]) {
		if (phone) await page.getByRole("button", { name: "菜单", exact: true }).click();
		await expect(page.getByRole("button", { name: "重载资源", exact: true })).toBeVisible();
		await page.getByRole("button", { name: title, exact: true }).click();
		const dialog = page.getByRole("dialog", { name: title, exact: true });
		await expect(dialog).toBeVisible();
		await expect(dialog).toHaveCSS("position", "static");
		await page.keyboard.press("Escape");
	}
	await expect(editor).toHaveValue(draft);
	await expect(page.getByRole("button", { name: "输入历史", exact: true })).toBeDisabled();
	await editor.fill("");
}

export async function exerciseTree(page: Page) {
	await page.getByRole("button", { name: "展开会话信息", exact: true }).click();
	const sidebar = page.getByRole("complementary", { name: "会话信息", exact: true });
	await sidebar.getByRole("tab", { name: "会话树", exact: true }).click();
	const row = sidebar.getByRole("listitem").filter({ hasText: "验证真实工具" }).first();
	await expect(row).toBeVisible();
	await row.getByRole("button", { name: /^定位消息/ }).click();
	await expect(page.locator('.message.user').filter({ hasText: "验证真实工具" })).toBeInViewport();
	await expect(sidebar.locator('[data-role="toolResult"]')).toHaveCount(0);
	await row.getByRole("button", { name: "编辑标签", exact: true }).click();
	await sidebar.getByRole("textbox", { name: "分支标签", exact: true }).fill("已检查");
	await sidebar.getByRole("button", { name: "保存标签", exact: true }).click();
	await expect(row.locator(".tree-label")).toHaveText("已检查");
	await row.getByRole("button", { name: "编辑标签", exact: true }).click();
	await sidebar.getByRole("textbox", { name: "分支标签", exact: true }).fill("");
	await sidebar.getByRole("button", { name: "保存标签", exact: true }).click();
	await expect(row).toBeVisible();
	await expect(row.locator(".tree-label")).toHaveCount(0);
	const viewport = page.viewportSize();
	for (const size of [viewport, { width: 320, height: 568 }, { width: 640, height: 360 }]) {
		if (size) await page.setViewportSize(size);
		for (const jump of [sidebar.locator(".tree-jump").first(), sidebar.locator(".tree-jump").last()]) {
			await jump.click();
			await expect.poll(() => page.evaluate(() => ({
				window: window.scrollY,
				containers: [...document.querySelectorAll("html, body, #root, .app, .chat-workspace, .main-panel, .session-sidebar")].map((element) => ({ name: element.tagName + element.className, scroll: element.scrollTop })),
				header: document.querySelector(".topbar")?.getBoundingClientRect().top,
			}))).toEqual({
				window: 0,
				containers: ["HTML", "BODY", "DIV", "DIVapp", "DIVchat-workspace", "MAINmain-panel", "ASIDEsession-sidebar"].map((name) => ({ name, scroll: 0 })),
				header: 0,
			});
		}
	}
	if (viewport) await page.setViewportSize(viewport);
	await page.locator(".topbar").hover();
	await page.mouse.wheel(0, 1200);
	await expect.poll(() => page.locator(".topbar").evaluate((element) => element.getBoundingClientRect().top)).toBe(0);
	await page.getByRole("button", { name: "收起会话信息", exact: true }).click();
}
