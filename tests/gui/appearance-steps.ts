import { expect, type Page } from "@playwright/test";
import path from "node:path";
import { expectComposerLayout } from "./composer-steps.ts";

export async function exerciseModelAppearance(page: Page, screenshotName: string) {
	const panel = page.getByRole("dialog", { name: "模型", exact: true });
	const search = panel.getByRole("textbox", { name: "搜索模型" });
	const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
	for (const colorScheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme });
		await page.screenshot({ animations: "disabled", path: path.resolve("dist", `gui-models-${colorScheme}-${screenshotName}.png`) });
	}
	await page.emulateMedia({ colorScheme: "light" });
	for (const size of [
		{ width: 320, height: 568, font: "100%" },
		{ width: 640, height: 360, font: "100%" },
		{ width: 390, height: 844, font: "125%" },
		{ width: 1200, height: 820, font: "200%" },
	]) {
		await page.setViewportSize({ width: size.width, height: size.height });
		await page.evaluate((font) => { document.documentElement.style.fontSize = font; }, size.font);
		await search.fill("third");
		await expect(panel.getByRole("checkbox")).toHaveCount(1);
		await panel.getByRole("checkbox").scrollIntoViewIfNeeded();
		await expect(panel.getByRole("checkbox")).toBeInViewport({ ratio: 1 });
		await search.fill("");
		const save = panel.getByRole("button", { name: "保存模型", exact: true });
		await save.scrollIntoViewIfNeeded();
		await expect(save).toBeInViewport({ ratio: 1 });
		await expect(panel.getByRole("button", { name: "关闭面板", exact: true })).toBeInViewport({ ratio: 1 });
		for (const element of [panel, panel.locator(".panel-body"), panel.locator(".model-catalog"), panel.locator(".model-manager-footer")]) {
			expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
		}
	}
	await page.evaluate(() => { document.documentElement.style.removeProperty("font-size"); });
	await page.setViewportSize(viewport);
}

export async function exerciseMainAppearance(page: Page, screenshotName: string) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	for (const colorScheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme });
		await page.screenshot({ animations: "disabled", path: path.resolve("dist", `gui-welcome-${colorScheme}-${screenshotName}.png`) });
	}
	await page.emulateMedia({ colorScheme: "light" });
	await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
	await editor.fill("放大文字后仍可编辑消息与选择模型。");
	await expect(editor).toBeInViewport();
	await expect(page.getByRole("button", { name: "发送", exact: true })).toBeInViewport({ ratio: 1 });
	await expectComposerLayout(page);
	await page.evaluate(() => { document.documentElement.style.removeProperty("font-size"); });
	await editor.fill("");
}
