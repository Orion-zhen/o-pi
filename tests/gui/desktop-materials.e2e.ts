import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { test, expect } from "./desktop-fixture.ts";
import { selectSetting } from "./settings-steps.ts";
import { readGuiDefaults } from "../../src/gui/host/preferences.ts";
import { GUI_BACKGROUNDS } from "../../src/gui/theme-base.ts";

test("原生窗口透明度不被重复叠加，关闭桌面透明后仍保留页面材质", async ({ gui: { app, page }, workspace: { agentDir } }) => {
	const defaults = readGuiDefaults().materials;
	await writeFile(path.join(agentDir, "configs", "gui.jsonc"), "{}\n");
	await page.emulateMedia({ colorScheme: "light" });
	await page.getByRole("button", { name: "设置", exact: true }).click();
	const settings = page.getByRole("dialog", { name: "设置", exact: true });
	await selectSetting(page, "主题", "浅色");
	await settings.getByRole("spinbutton", { name: "左侧栏不透明度", exact: true }).fill("55");
	await settings.getByRole("spinbutton", { name: "内容画布不透明度", exact: true }).fill("82");
	const save = settings.getByRole("button", { name: "保存", exact: true });
	await save.click();
	await expect(save).toBeDisabled();
	await settings.getByRole("button", { name: "关闭面板", exact: true }).click();
	await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
	await expect(page.locator("html")).toHaveAttribute("data-desktop-transparency-supported", /true|false/);
	if (process.platform === "linux") {
		await expect(page.locator(".app")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		const image = await loadImage(await page.screenshot());
		const context = createCanvas(image.width, image.height).getContext("2d");
		context.drawImage(image, 0, 0);
		for (const [selector, opacity] of [[".sidebar", 55], [".conversation-canvas", 82]] as const) {
			const bounds = await page.locator(selector).boundingBox();
			if (!bounds) throw new Error(`${selector} 不可见`);
			for (const y of [bounds.y + 4, bounds.y + bounds.height - 4]) {
				expect(context.getImageData(bounds.x + 4, y, 1, 1).data[3]).toBe(Math.round(255 * opacity / 100));
			}
		}
	}
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await settings.getByRole("switch", { name: "桌面背景透明", exact: true }).click();
	await save.click();
	await expect(save).toBeDisabled();
	await expect(page.locator(".app")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor().toUpperCase())).toBe(GUI_BACKGROUNDS.light);
	await expect(page.locator(".sidebar")).toHaveCSS("backdrop-filter", `blur(${defaults.sidebar.blur}px) saturate(${defaults.sidebar.saturation / 100})`);
});
