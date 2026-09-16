import { expect, type Page } from "@playwright/test";

export async function exercisePanels(page: Page) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const sidebar = page.getByRole("complementary", { name: "会话信息", exact: true });
	const draft = "保留未发送草稿";
	await editor.fill(draft);
	await expect(sidebar).toBeVisible();
	for (const title of ["会话统计", "遥测"]) {
		await sidebar.getByRole("tab", { name: title, exact: true }).click();
		await expect(sidebar.getByRole("tab", { name: title, exact: true })).toHaveAttribute("aria-selected", "true");
		await expect(editor).toBeEditable();
		await expect(editor).toHaveValue(draft);
	}

	const tools = page.getByRole("button", { name: /^工具：已启用/ });
	const count = Number(await tools.innerText());
	await tools.click();
	const toolPanel = page.getByRole("dialog", { name: "工具选择", exact: true });
	const checkbox = toolPanel.locator("label").filter({ has: page.getByText("websearch", { exact: true }) }).getByRole("checkbox");
	await expect(checkbox).toBeChecked();
	await checkbox.click();
	await toolPanel.getByRole("button", { name: "关闭面板" }).click();
	await expect(tools).toHaveText(String(count - 1));
	await tools.click();
	await checkbox.click();
	await page.keyboard.press("Escape");
	await expect(tools).toHaveText(String(count));
	await page.getByRole("button", { name: "收起会话信息", exact: true }).click();
	await expect(sidebar).toHaveCount(0);
	await page.getByRole("button", { name: "展开会话信息", exact: true }).click();
	await expect(sidebar.getByRole("tab", { name: "遥测", exact: true })).toHaveAttribute("aria-selected", "true");
	await page.getByRole("button", { name: "收起会话信息", exact: true }).click();

	for (const title of ["系统提示词", "命令帮助", "导入会话"]) {
		await page.getByRole("button", { name: "会话操作", exact: true }).click();
		await page.getByRole("menuitem", { name: title, exact: true }).click();
		const dialog = page.getByRole("dialog", { name: title, exact: true });
		await expect(dialog).toBeVisible();
		await dialog.getByRole("button", { name: "关闭面板", exact: true }).click();
	}
	const phone = (page.viewportSize()?.width ?? 1200) < 768;
	for (const title of ["认证", "套餐用量"]) {
		if (phone) await page.getByRole("button", { name: "菜单", exact: true }).click();
		await page.getByRole("button", { name: title, exact: true }).click();
		await expect(page.getByRole("dialog", { name: title, exact: true })).toBeVisible();
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
	await row.getByRole("button", { name: /^定位消息/ }).click();
	await expect(page.locator('.message.user').filter({ hasText: "验证真实工具" })).toBeInViewport();
	await row.getByRole("button", { name: "编辑标签", exact: true }).click();
	await sidebar.getByRole("textbox", { name: "分支标签", exact: true }).fill("已检查");
	await sidebar.getByRole("button", { name: "保存标签", exact: true }).click();
	await expect(row.locator(".tree-label")).toHaveText("已检查");
	await row.getByRole("button", { name: "编辑标签", exact: true }).click();
	await sidebar.getByRole("textbox", { name: "分支标签", exact: true }).fill("");
	await sidebar.getByRole("button", { name: "保存标签", exact: true }).click();
	await expect(row.locator(".tree-label")).toHaveCount(0);
	await page.getByRole("button", { name: "收起会话信息", exact: true }).click();
}
