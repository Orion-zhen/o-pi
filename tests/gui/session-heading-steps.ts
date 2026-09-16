import { expect, type Page } from "@playwright/test";

export async function exerciseSessionHeading(page: Page) {
	const title = page.locator(".session-heading button");
	const input = page.getByRole("textbox", { name: "会话名称", exact: true });
	const original = await title.innerText();
	await title.click();
	await expect(input).toHaveValue(original);
	await input.fill("点击外部保存");
	await page.getByRole("textbox", { name: "消息", exact: true }).click();
	await expect(title).toHaveText("点击外部保存");

	await title.click();
	await input.fill("取消修改");
	await input.press("Escape");
	await expect(title).toHaveText("点击外部保存");
	await title.click();
	await input.fill("   ");
	await input.press("Tab");
	await expect(title).toHaveText("点击外部保存");

	await title.click();
	await input.fill(original);
	await input.press("Enter");
	await expect(title).toHaveText(original);
}
