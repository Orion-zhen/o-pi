import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "jsonc-parser";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixture.ts";
import { selectSetting, selectSettingsCategory } from "./settings-steps.ts";
import { readGuiDefaults } from "../../src/gui/host/preferences.ts";

const defaults = readGuiDefaults().materials;
const alpha = (opacity: number) => new RegExp(`[/,] ${String(opacity / 100).replace(".", "\\.")}\\)$`);
const settings = (page: Page) => page.getByRole("dialog", { name: "设置", exact: true });
const field = (page: Page, region: string, parameter = "不透明度") => settings(page).getByRole("spinbutton", { name: `${region}${parameter}`, exact: true });
async function openSettings(page: Page) {
	if ((page.viewportSize()?.width ?? 1200) < 768) await page.getByRole("button", { name: "菜单", exact: true }).click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
}
async function save(page: Page) {
	const button = settings(page).getByRole("button", { name: "保存", exact: true });
	await button.click();
	await expect(button).toBeDisabled();
}

test.describe("页面材质", () => {
	test.beforeEach(async ({ gui: { page }, workspace: { agentDir } }) => {
		await writeFile(path.join(agentDir, "configs", "gui.jsonc"), "{}\n");
		await page.emulateMedia({ colorScheme: "light" });
		await openSettings(page);
	});

	test("分区实时预览，切换分类保留草稿，放弃和关闭恢复已保存材质", async ({ gui: { page }, workspace: { agentDir } }) => {
		const opacity = field(page, "左侧栏");
		await opacity.fill("55");
		await expect(settings(page).getByRole("img", { name: "界面材质预览：左侧栏", exact: true })).toBeVisible();
		await field(page, "左侧栏", "模糊").fill("18");
		await field(page, "左侧栏", "饱和度").fill("140");
		await expect(page.locator(".sidebar")).toHaveCSS("background-color", alpha(55));
		await expect(page.locator(".sidebar")).toHaveCSS("backdrop-filter", "blur(18px) saturate(1.4)");
		await opacity.fill("");
		await opacity.press("Enter");
		await expect(opacity).toHaveValue("55");
		await field(page, "菜单与浮层", "模糊").fill("30");
		await expect(settings(page).locator(".material-preview-floating")).toHaveCSS("backdrop-filter", `blur(30px) saturate(${defaults.floating.saturation / 100})`);
		await expect(page.locator(".sidebar")).toHaveCSS("backdrop-filter", "blur(18px) saturate(1.4)");
		await field(page, "弹窗").fill("35");
		await expect(settings(page)).toHaveCSS("background-color", alpha(35));
		expect(parse(await readFile(path.join(agentDir, "configs", "gui.jsonc"), "utf8"))).toEqual({});
		await selectSettingsCategory(page, "交互");
		await selectSettingsCategory(page, "外观");
		await expect(opacity).toHaveValue("55");
		await settings(page).getByRole("button", { name: "放弃修改", exact: true }).click();
		await expect(page.locator(".sidebar")).toHaveCSS("background-color", alpha(defaults.sidebar.opacity));
		await expect(opacity).toHaveValue(String(defaults.sidebar.opacity));
		await opacity.fill("20");
		await expect(page.locator(".sidebar")).toHaveCSS("background-color", alpha(20));
		await settings(page).getByRole("button", { name: "关闭面板", exact: true }).click();
		await page.getByRole("button", { name: "放弃并关闭", exact: true }).click();
		await expect(settings(page)).toHaveCount(0);
		await expect(page.locator(".sidebar")).toHaveCSS("background-color", alpha(defaults.sidebar.opacity));
	});

	test("保存区域参数，重新加载后继续生效", async ({ gui: { page }, workspace: { agentDir } }) => {
		await field(page, "内容画布").fill("82");
		await field(page, "内容画布", "模糊").fill("28");
		await field(page, "内容画布", "饱和度").fill("95");
		await field(page, "会话信息栏").fill("78");
		await save(page);
		expect(parse(await readFile(path.join(agentDir, "configs", "gui.jsonc"), "utf8"))).toEqual({ materials: { canvas: { opacity: 82, blur: 28, saturation: 95 }, inspector: { opacity: 78 } } });
		await page.reload();
		await expect(page.locator(".conversation-canvas")).toHaveCSS("background-color", alpha(82));
		await expect(page.locator(".conversation-canvas")).toHaveCSS("backdrop-filter", "blur(28px) saturate(0.95)");
		await expect(page.locator(".session-sidebar")).toHaveCSS("background-color", alpha(78));
		await expect(page.locator(".app")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	});

	test("外部配置刷新不覆盖材质草稿，放弃后采用最新配置", async ({ gui: { page }, workspace: { agentDir } }) => {
		await field(page, "左侧栏").fill("20");
		const primary = await page.evaluate(() => document.documentElement.style.getPropertyValue("--primary"));
		await writeFile(path.join(agentDir, "configs", "gui.jsonc"), JSON.stringify({ themeColor: "#AF52DE", materials: { sidebar: { opacity: 65 } } }));
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--primary"))).not.toBe(primary);
		await expect(field(page, "左侧栏")).toHaveValue("20");
		await expect(page.locator(".sidebar")).toHaveCSS("background-color", alpha(20));
		await settings(page).getByRole("button", { name: "放弃修改", exact: true }).click();
		await expect(field(page, "左侧栏")).toHaveValue("65");
		await expect(page.locator(".sidebar")).toHaveCSS("background-color", alpha(65));
	});

	test("外部配置无效时，已有草稿仍按最后生效的主题编辑", async ({ gui: { page }, workspace: { agentDir } }) => {
		const file = path.join(agentDir, "configs", "gui.jsonc");
		await field(page, "左侧栏").fill("67");
		await writeFile(file, '{"theme":"dark"}');
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect(field(page, "左侧栏")).toHaveValue(String(defaults.sidebar.darkOpacity));
		await writeFile(file, '{"theme":"invalid"}');
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect(page.getByRole("alert", { includeHidden: true }).filter({ hasText: "GUI 配置无效" })).toBeAttached();
		await field(page, "左侧栏").fill("91");
		await expect(page.locator(".sidebar")).toHaveCSS("background-color", alpha(91));
	});

	test("深浅色按生效主题独立编辑，跟随系统和区域重置不覆盖另一模式", async ({ gui: { page }, workspace: { agentDir } }) => {
		const opacity = field(page, "左侧栏");
		await selectSetting(page, "主题", "深色");
		await expect(opacity).toHaveValue(String(defaults.sidebar.opacity));
		await save(page);
		await expect(opacity).toHaveValue(String(defaults.sidebar.darkOpacity));
		await opacity.fill("91");
		await save(page);
		expect(parse(await readFile(path.join(agentDir, "configs", "gui.jsonc"), "utf8"))).toEqual({ theme: "dark", materials: { sidebar: { darkOpacity: 91 } } });
		await expect(page.locator(".sidebar")).toHaveCSS("background-color", alpha(91));
		await selectSetting(page, "主题", "跟随系统");
		await save(page);
		await expect(opacity).toHaveValue(String(defaults.sidebar.opacity));
		await opacity.fill("67");
		await page.emulateMedia({ colorScheme: "dark" });
		await expect(opacity).toHaveValue("91");
		await field(page, "左侧栏", "模糊").fill("30");
		await settings(page).getByRole("button", { name: "重置左侧栏材质", exact: true }).click();
		await expect(opacity).toHaveValue(String(defaults.sidebar.darkOpacity));
		await expect(field(page, "左侧栏", "模糊")).toHaveValue(String(defaults.sidebar.blur));
		await page.emulateMedia({ colorScheme: "light" });
		await expect(opacity).toHaveValue("67");
		await save(page);
		expect(parse(await readFile(path.join(agentDir, "configs", "gui.jsonc"), "utf8"))).toEqual({ materials: { sidebar: { opacity: 67 } } });
	});

	test("关闭材质使用实色，恢复默认清除外观覆盖", async ({ gui: { page }, workspace: { agentDir } }) => {
		await field(page, "左侧栏").fill("55");
		await settings(page).getByRole("checkbox", { name: "启用磨砂材质", exact: true }).click();
		await expect(field(page, "左侧栏")).toBeDisabled();
		await save(page);
		await page.reload();
		for (const selector of [".sidebar", ".conversation-canvas"]) {
			await expect(page.locator(selector)).toHaveCSS("backdrop-filter", "none");
			await expect(page.locator(selector)).not.toHaveCSS("background-color", /[/,] 0\./);
		}
		await openSettings(page);
		await settings(page).getByRole("button", { name: "恢复本页默认设置", exact: true }).click();
		await expect(field(page, "左侧栏")).toHaveValue(String(defaults.sidebar.opacity));
		await expect(page.locator(".sidebar")).toHaveCSS("background-color", alpha(defaults.sidebar.opacity));
		await save(page);
		expect(parse(await readFile(path.join(agentDir, "configs", "gui.jsonc"), "utf8"))).toEqual({});
	});

	test("系统减少透明度与高对比度优先于材质配置", async ({ gui: { page } }) => {
		const cdp = await page.context().newCDPSession(page);
		try {
			for (const [name, value] of [["prefers-reduced-transparency", "reduce"], ["prefers-contrast", "more"], ["forced-colors", "active"]] as const) {
				await cdp.send("Emulation.setEmulatedMedia", { features: [{ name, value }] });
				for (const selector of [".sidebar", ".conversation-canvas", ".session-sidebar"]) {
					await expect(page.locator(selector)).toHaveCSS("backdrop-filter", "none");
					await expect(page.locator(selector)).not.toHaveCSS("background-color", /[/,] 0\./);
				}
				await expect(page.locator(".app")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
			}
			await cdp.send("Emulation.setEmulatedMedia", { features: [] });
		} finally { await cdp.detach(); }
		await page.emulateMedia({ colorScheme: "light" });
		await expect(page.locator(".sidebar")).toHaveCSS("background-color", alpha(defaults.sidebar.opacity));
	});
});
