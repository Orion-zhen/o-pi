import { expect, type Locator, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "jsonc-parser";

export async function checkThemeColor(page: Page, settings: Locator, configFile: string, openSettings: () => Promise<void>, artifact: string) {
	const trigger = settings.getByRole("button", { name: "主题色", exact: true });
	const picker = page.getByLabel("主题色调色板", { exact: true });
	const input = picker.getByRole("textbox", { name: "主题色 HEX", exact: true });
	const colors = () => page.evaluate(() => ["body", ".composer-card", ".sidebar"].map((selector) => {
		const node = document.querySelector(selector);
		if (!node) throw new Error(`未找到 ${selector}`);
		return getComputedStyle(node).backgroundColor;
	}));
	const storedColor = async (): Promise<unknown> => (parse(await readFile(configFile, "utf8")) as { themeColor?: unknown }).themeColor;
	await expect(trigger).toContainText("#007AFF");
	const initial = await colors();
	await trigger.click();
	await input.fill("#AF52DE");
	await expect.poll(colors).not.toEqual(initial);
	expect(await storedColor()).toBeUndefined();
	await input.press("Enter");
	await expect.poll(storedColor).toBe("#AF52DE");
	await expect(input).toBeEnabled();
	const purple = await colors();
	await picker.getByRole("button", { name: "主题色 #FFCC00", exact: true }).click();
	await expect.poll(storedColor).toBe("#FFCC00");
	await expect.poll(colors).not.toEqual(purple);
	const hue = picker.getByRole("slider", { name: "色相", exact: true });
	await expect(hue).toBeEnabled();
	const track = await hue.boundingBox();
	if (!track) throw new Error("色相滑块不可见");
	const yellow = await colors();
	await page.mouse.move(track.x + track.width / 2, track.y + track.height / 2);
	await page.mouse.down();
	await page.mouse.move(track.x + track.width * 0.7, track.y + track.height / 2, { steps: 8 });
	await expect.poll(colors).not.toEqual(yellow);
	expect(await storedColor()).toBe("#FFCC00");
	await page.mouse.up();
	await expect.poll(storedColor).not.toBe("#FFCC00");
	const saturation = picker.getByRole("slider", { name: "饱和度", exact: true });
	await expect(saturation).toBeEnabled();
	await saturation.press("Home");
	await expect(saturation).toHaveValue("0");
	await expect(input).toBeEnabled();
	const gray = await storedColor();
	await input.fill("bad");
	await input.press("Enter");
	await expect(input).toHaveAttribute("aria-invalid", "true");
	await expect(picker.getByRole("alert")).toContainText("#RRGGBB");
	expect(await storedColor()).toBe(gray);
	await input.fill("#AF52DE");
	await input.press("Enter");
	await expect.poll(storedColor).toBe("#AF52DE");
	await expect(input).toBeEnabled();
	await expect(trigger).toContainText("#AF52DE");
	for (const mode of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme: mode });
		const foreground = await page.locator("body").evaluate((element) => getComputedStyle(element).color);
		await expect(trigger).toHaveCSS("color", foreground);
		await expect(picker).toHaveCSS("color", foreground);
		await page.screenshot({ path: `dist/gui-theme-${mode}-${artifact}.png`, animations: "disabled" });
	}
	await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
	await expect.poll(() => picker.evaluate((element) => {
		const box = element.getBoundingClientRect();
		return element.scrollWidth <= element.clientWidth + 1 && box.left >= 0 && box.right <= innerWidth;
	})).toBe(true);
	await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
	await page.emulateMedia({ colorScheme: "light" });

	// 外部编辑导致保存冲突时，撤销预览，不覆盖磁盘内容。
	const external = `${await readFile(configFile, "utf8")}\n// 外部修改\n`;
	await writeFile(configFile, external);
	await input.fill("#34C759");
	await expect.poll(colors).not.toEqual(purple);
	await input.press("Enter");
	await expect(input).toHaveValue("#AF52DE");
	await expect.poll(colors).toEqual(purple);
	expect(await readFile(configFile, "utf8")).toBe(external);
	await page.keyboard.press("Escape");
	await expect(picker).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(settings).toHaveCount(0);
	await expect(page.locator(".error-banner")).toContainText("已被修改");
	await page.getByRole("button", { name: "关闭错误提示", exact: true }).click();
	await page.reload();
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
	await expect.poll(colors).toEqual(purple);
	await openSettings();
	await expect(trigger).toContainText("#AF52DE");
	await page.emulateMedia({ colorScheme: "dark" });
	await expect.poll(colors).not.toEqual(purple);
	await page.emulateMedia({ colorScheme: "light" });
	await expect.poll(colors).toEqual(purple);
	await settings.getByRole("button", { name: "重置主题色", exact: true }).click();
	await expect(trigger).toContainText("#007AFF");
	await expect.poll(storedColor).toBeUndefined();
	await expect.poll(colors).toEqual(initial);
}
