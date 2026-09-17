import { expect, type Locator, type Page } from "@playwright/test";

export async function selectSetting(page: Page, name: string, option: string) {
	await page.getByRole("combobox", { name, exact: true }).click();
	await page.getByRole("option", { name: option, exact: true }).click();
	await expect(page.getByRole("listbox")).toHaveCount(0);
}

export async function selectSettingsCategory(page: Page, label: string) {
	if ((page.viewportSize()?.width ?? 1200) < 768) await selectSetting(page, "设置分类", label);
	else await page.getByRole("tab", { name: label, exact: true }).click();
}

export async function checkSettingsLayout(page: Page, settings: Locator, artifact: string) {
	const viewport = page.viewportSize();
	if (!viewport) throw new Error("设置测试需要视口尺寸");
	const dimensions = () => settings.evaluate((node) => ({ width: node.clientWidth, height: node.clientHeight }));
	const checkCategories = async () => {
		const original = await dimensions();
		for (const label of ["交互", "会话行为", "外观"]) {
			await selectSettingsCategory(page, label);
			await expect(settings.getByRole("heading", { name: label, exact: true })).toBeVisible();
			expect(await dimensions()).toEqual(original);
			const content = settings.getByRole("tabpanel", { name: label, exact: true });
			expect(await content.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
			await expect(settings.getByRole("button", { name: "关闭面板", exact: true })).toBeInViewport();
		}
	};
	await checkCategories();
	for (const colorScheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme });
		await page.screenshot({ path: `dist/gui-settings-${colorScheme}-${artifact}.png`, animations: "disabled" });
	}
	await selectSettingsCategory(page, "交互");
	await page.screenshot({ path: `dist/gui-settings-interaction-${artifact}.png`, animations: "disabled" });
	await page.setViewportSize({ width: 1000, height: 400 });
	await checkCategories();
	await settings.getByRole("tab", { name: "外观", exact: true }).focus();
	await page.keyboard.press("ArrowDown");
	await expect(settings.getByRole("tab", { name: "交互", exact: true })).toBeFocused();
	await expect(settings.getByRole("heading", { name: "交互", exact: true })).toBeVisible();
	await page.setViewportSize(viewport);
	await selectSettingsCategory(page, "外观");
	await page.emulateMedia({ colorScheme: "light" });
	const fontSize = settings.getByRole("spinbutton", { name: "界面字号", exact: true });
	await fontSize.fill("28");
	await fontSize.press("Enter");
	await expect(fontSize).toBeEnabled();
	await checkCategories();
	await settings.getByRole("button", { name: "重置界面字号", exact: true }).click();
	await expect(fontSize).toHaveValue("14");
}
