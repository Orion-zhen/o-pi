import { type Page } from "@playwright/test";

export async function selectSetting(page: Page, name: string, option: string) {
	await page.getByRole("combobox", { name, exact: true }).click();
	await page.getByRole("option", { name: option, exact: true }).click();
}

export async function selectSettingsCategory(page: Page, label: string) {
	if ((page.viewportSize()?.width ?? 1200) < 768) await selectSetting(page, "设置分类", label);
	else await page.getByRole("tab", { name: label, exact: true }).click();
}
