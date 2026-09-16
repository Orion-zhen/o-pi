import { expect, type Page } from "@playwright/test";
import path from "node:path";

export async function exerciseModelSelects(page: Page, screenshotName: string) {
	const model = page.getByRole("combobox", { name: "模型", exact: true });
	const thinking = page.getByRole("combobox", { name: "思考级别", exact: true });
	const initialThinking = await thinking.innerText();
	const panel = page.getByRole("dialog", { name: "模型", exact: true });
	for (const keyboard of [false, true]) {
		await model.click();
		const manage = page.getByRole("option", { name: "管理模型", exact: true });
		if (keyboard) {
			await expect(page.getByRole("option", { name: "GUI Test Model", exact: true })).toBeFocused();
			await page.keyboard.press("End");
			await expect(manage).toBeFocused();
			await page.keyboard.press("Enter");
		} else await manage.click();
		await expect(page.getByRole("listbox")).toHaveCount(0);
		await expect(panel.getByRole("textbox", { name: "搜索模型" })).toBeVisible();
		await expect(panel.locator(".current-model strong")).toHaveText("GUI Test Model");
		await expect.poll(() => panel.evaluate((node) => node.contains(document.activeElement))).toBe(true);
		await page.keyboard.press("Escape");
		await expect(panel).toHaveCount(0);
		await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
		await expect(model).toHaveText("GUI Test Model");
	}
	await model.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("option", { name: "GUI Test Model", exact: true })).toBeFocused();
	await page.keyboard.press("Home");
	await expect(page.getByRole("option", { name: "GUI Second Model", exact: true })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(model).toHaveText("GUI Second Model");
	await expect(model).toBeFocused();
	await model.click();
	await page.getByRole("option", { name: "GUI Test Model", exact: true }).click();
	await expect(model).toHaveText("GUI Test Model");

	await thinking.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("option", { name: initialThinking, exact: true })).toBeFocused();
	await page.keyboard.press("Home");
	await expect(page.getByRole("option", { name: "off", exact: true })).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(page.getByRole("option", { name: "minimal", exact: true })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(thinking).toHaveText("minimal");
	await expect(thinking).toBeFocused();
	await thinking.click();
	await expect(page.getByRole("option", { name: "minimal", exact: true })).toBeFocused();
	await page.keyboard.press("l");
	await expect(page.getByRole("option", { name: "low", exact: true })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(thinking).toHaveText("low");
	await thinking.click();
	await page.getByRole("option", { name: initialThinking, exact: true }).click();
	await expect(thinking).toHaveText(initialThinking);

	// 深浅色悬停和窄屏由 Web 覆盖，原生窗口验证桌面交互。
	if (screenshotName === "electron") return;
	for (const colorScheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
		for (const [name, trigger] of [["model", model], ["thinking", thinking]] as const) {
			await page.getByRole("textbox", { name: "消息", exact: true }).hover();
			await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
			await trigger.hover();
			await expect(trigger).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
			await page.locator(".composer").screenshot({ animations: "disabled", path: path.resolve("dist", `gui-select-hover-${name}-${colorScheme}-${screenshotName}.png`) });
			await trigger.click();
			await expect(page.getByRole("listbox")).toBeVisible();
			await page.screenshot({ animations: "disabled", path: path.resolve("dist", `gui-select-${name}-${colorScheme}-${screenshotName}.png`) });
			await page.keyboard.press("Escape");
			await expect(trigger).toBeFocused();
		}
	}
	await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
	const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
	for (const size of [{ width: 320, height: 568 }, { width: 640, height: 360 }]) {
		await page.setViewportSize(size);
		for (const trigger of [model, thinking]) {
			await trigger.click();
			const menu = page.getByRole("listbox");
			await expect(menu).toBeInViewport({ ratio: 1 });
			await page.getByRole("option").last().scrollIntoViewIfNeeded();
			await expect(page.getByRole("option").last()).toBeInViewport({ ratio: 1 });
			expect(await menu.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
			await page.keyboard.press("Escape");
			await expect(trigger).toBeFocused();
		}
	}
	await page.setViewportSize(viewport);
}
