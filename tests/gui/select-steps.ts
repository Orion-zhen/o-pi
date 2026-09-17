import { expect, type Page } from "@playwright/test";

export async function exerciseModelSelects(page: Page) {
	const model = page.getByRole("combobox", { name: "模型", exact: true });
	const thinking = page.getByRole("combobox", { name: "思考级别", exact: true });
	const initialThinking = await thinking.innerText();
	await model.click();
	await page.getByRole("option", { name: "管理模型", exact: true }).click();
	const panel = page.getByRole("dialog", { name: "模型", exact: true });
	await expect(panel.getByRole("textbox", { name: "搜索模型" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(panel).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();

	await model.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("option", { name: "GUI Test Model", exact: true })).toBeFocused();
	await page.keyboard.press("Home");
	await expect(page.getByRole("option", { name: "GUI Second Model", exact: true })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(model).toHaveText("GUI Second Model");
	await model.click();
	await page.getByRole("option", { name: "GUI Test Model", exact: true }).click();
	await expect(model).toHaveText("GUI Test Model");

	await thinking.click();
	await page.getByRole("option", { name: "minimal", exact: true }).click();
	await expect(thinking).toHaveText("minimal");
	await thinking.click();
	await page.getByRole("option", { name: initialThinking, exact: true }).click();
	await expect(thinking).toHaveText(initialThinking);
}
