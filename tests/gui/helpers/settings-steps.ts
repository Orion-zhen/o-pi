import { type Page } from "@playwright/test";

export async function selectSetting(page: Page, name: string, option: string) {
	await page.getByRole("combobox", { name, exact: true }).click();
	await page.getByRole("option", { name: option, exact: true }).click();
}

export async function selectSettingsCategory(page: Page, label: string) {
	if ((page.viewportSize()?.width ?? 1200) < 768) {
		await page.getByRole("combobox", { name: "设置分类", exact: true }).click();
		const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		await page.getByRole("option", { name: new RegExp(`^${escaped}(?: •)?$`) }).click();
	} else await page.getByRole("tab", { name: label, exact: true }).click();
}
