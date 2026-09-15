import { expect, type Page } from "@playwright/test";

export async function expectSessionHeadingLayout(page: Page) {
	const heading = page.locator(".session-heading");
	await expect(heading.locator("small")).toHaveCount(0);
	const layout = await page.locator(".topbar").evaluate((bar) => {
		const name = bar.querySelector(".session-name");
		const status = bar.querySelector(".connection-status");
		if (!(name instanceof HTMLElement) || !(status instanceof HTMLElement)) throw new Error("缺少顶栏内容");
		const titleRect = name.getBoundingClientRect();
		const statusRect = status.getBoundingClientRect();
		return {
			fits: titleRect.width > 0 && titleRect.left >= 0 && titleRect.right <= statusRect.left && statusRect.right <= innerWidth,
			fontSize: Number.parseFloat(getComputedStyle(name).fontSize),
			baseSize: Number.parseFloat(getComputedStyle(document.querySelector(".app") ?? bar).fontSize),
		};
	});
	expect(layout.fits).toBe(true);
	expect(layout.fontSize).toBeGreaterThan(layout.baseSize);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

export async function exerciseSessionHeading(page: Page) {
	const title = page.locator(".session-heading button");
	const input = page.getByRole("textbox", { name: "会话名称", exact: true });
	const original = await title.innerText();
	await title.click();
	await expect(input).toBeFocused();
	await expect(input).toHaveValue(original);
	await input.fill("点击外部保存");
	await input.click();
	await expect(input).toBeVisible();
	await page.locator(".connection-status").click();
	await expect(input).toHaveCount(0);
	await expect(title).toHaveText("点击外部保存");

	await title.click();
	await input.fill("取消修改");
	await input.press("Escape");
	await expect(input).toHaveCount(0);
	await expect(title).toHaveText("点击外部保存");
	await title.click();
	await input.fill("   ");
	await input.press("Tab");
	await expect(title).toHaveText("点击外部保存");

	const longName = "响应式布局中的长会话名称".repeat(16);
	await title.click();
	await input.fill(longName);
	await input.press("Enter");
	await expect(title).toHaveText(longName);
	await expectSessionHeadingLayout(page);
	expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
	await title.click();
	await expectSessionHeadingLayout(page);
	await input.fill(original);
	await page.getByRole("textbox", { name: "消息", exact: true }).click();
	await expect(input).toHaveCount(0);
	await expect(title).toHaveText(original);
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
}
