import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "jsonc-parser";
import type { Page } from "@playwright/test";
import { test, expect } from "./desktop-fixture.ts";
import { readGuiDefaults } from "../../src/gui/host/preferences.ts";

const defaults = readGuiDefaults().materials;
const translucent = /[/,] 0(?:\.\d+)?\)$/;
const alpha = (opacity: number) => new RegExp(`[/,] ${String(opacity / 100).replace(".", "\\.")}\\)$`);
const settings = (page: Page) => page.getByRole("dialog", { name: "设置", exact: true });
const surfaces = [".sidebar", ".sidebar-resize", ".conversation-canvas", ".topbar", ".session-sidebar", ".info-resize", ".composer-card"];
const sidebarFilter = `blur(${defaults.sidebar.blur}px) saturate(${defaults.sidebar.saturation / 100})`;

test.skip(process.platform !== "darwin", "macOS 桌面材质兼容");

for (const [theme, label] of [["light", "浅色"], ["dark", "深色"]] as const) test(`${label}原生磨砂不叠加背景滤镜，浮层实色且不覆盖透明度配置`, async ({ gui: { page }, workspace: { agentDir } }) => {
	const config = {
		theme,
		materials: {
			sidebar: { opacity: 55, darkOpacity: 79 },
			canvas: { opacity: 82, darkOpacity: 91 },
			floating: { opacity: 20, darkOpacity: 25 },
			dialog: { opacity: 30, darkOpacity: 35 },
		},
	};
	const file = path.join(agentDir, "configs", "gui.jsonc");
	const source = JSON.stringify(config);
	await writeFile(file, source);
	await page.emulateMedia({ colorScheme: theme });
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
	for (const selector of surfaces) await expect(page.locator(selector)).toHaveCSS("backdrop-filter", "none");
	await expect(page.locator(".app")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(page.locator(".sidebar")).toHaveCSS("background-color", alpha(theme === "light" ? 55 : 79));
	await expect(page.locator(".conversation-canvas")).toHaveCSS("background-color", alpha(theme === "light" ? 82 : 91));
	await page.getByRole("tab", { name: "会话统计", exact: true }).hover();
	await page.getByRole("tab", { name: "会话树", exact: true }).hover();

	await page.locator(".workspace-select").first().click();
	await expect(page.getByRole("textbox", { name: "筛选工作区", exact: true })).toBeVisible();
	await expect(page.locator(".workspace-options")).toHaveCSS("backdrop-filter", "none");
	await expect(page.locator(".workspace-options")).not.toHaveCSS("background-color", translucent);
	await page.keyboard.press("Escape");
	await expect(page.locator(".workspace-options")).toHaveCount(0);

	await page.getByRole("button", { name: "设置", exact: true }).click();
	await expect(settings(page)).not.toHaveCSS("background-color", translucent);
	for (const selector of [".modal-layer", ".modal-content", ".material-preview-sidebar", ".material-preview-canvas"]) {
		await expect(page.locator(selector)).toHaveCSS("backdrop-filter", "none");
	}
	await expect(page.locator(".modal-layer")).toHaveCSS("background-color", alpha(theme === "light" ? defaults.overlay.opacity : defaults.overlay.darkOpacity));
	const table = settings(page).getByRole("table", { name: "材质区域设置", exact: true });
	for (const region of ["左侧栏", "内容画布", "顶栏", "会话信息栏", "输入器", "弹窗遮罩"]) {
		await expect(table.getByRole("spinbutton", { name: `${region}不透明度`, exact: true })).toBeEditable();
	}
	await expect(table.getByRole("spinbutton", { name: /模糊|饱和度|菜单与浮层|^弹窗不透明度$/ })).toHaveCount(0);
	await table.getByRole("spinbutton", { name: "弹窗遮罩不透明度", exact: true }).focus();
	await expect(page.locator(".material-preview-overlay")).toHaveCSS("backdrop-filter", "none");
	await expect(page.locator(".material-preview-dialog")).not.toHaveCSS("background-color", translucent);
	await settings(page).getByRole("button", { name: "关闭面板", exact: true }).click();
	await expect(settings(page)).toHaveCount(0);

	await page.setViewportSize({ width: 600, height: 820 });
	await page.getByRole("button", { name: "菜单", exact: true }).click();
	await expect(page.locator(".mobile-sidebar")).toBeVisible();
	await expect(page.locator(".mobile-sidebar")).toHaveCSS("backdrop-filter", "none");
	await expect(page.locator(".mobile-sidebar")).not.toHaveCSS("background-color", translucent);
	await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCSS("backdrop-filter", "none");
	await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCSS("background-color", alpha(theme === "light" ? defaults.overlay.opacity : defaults.overlay.darkOpacity));
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await expect(table.getByRole("spinbutton", { name: "内容画布不透明度", exact: true })).toBeEditable();
	await expect.poll(() => table.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await settings(page).getByRole("button", { name: "关闭面板", exact: true }).click();
	await expect(settings(page)).toHaveCount(0);
	await page.setViewportSize({ width: 1200, height: 820 });
	await page.reload();
	for (const selector of surfaces) await expect(page.locator(selector)).toHaveCSS("backdrop-filter", "none");
	expect(await readFile(file, "utf8")).toBe(source);
});

test("桌面透明保存后才切换兼容策略，关闭后恢复页面滤镜及浮层透明度", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "configs", "gui.jsonc");
	const source = '{"theme":"light","materials":{"floating":{"opacity":25},"dialog":{"opacity":35}}}';
	await writeFile(file, source);
	await page.emulateMedia({ colorScheme: "light" });
	await page.reload();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	const toggle = settings(page).getByRole("checkbox", { name: "桌面背景透明", exact: true });
	const table = settings(page).getByRole("table", { name: "材质区域设置", exact: true });
	const blur = table.getByRole("spinbutton", { name: "左侧栏模糊", exact: true });
	await toggle.uncheck();
	await expect(blur).toBeHidden();
	await expect(page.locator(".sidebar")).toHaveCSS("backdrop-filter", "none");
	await expect(settings(page)).not.toHaveCSS("background-color", translucent);
	expect(await readFile(file, "utf8")).toBe(source);
	await settings(page).getByRole("button", { name: "保存", exact: true }).click();
	await expect(settings(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
	await expect(page.locator(".sidebar")).toHaveCSS("backdrop-filter", sidebarFilter);
	await expect(settings(page)).toHaveCSS("background-color", alpha(35));
	await expect(blur).toBeEditable();
	await expect(table.getByRole("spinbutton", { name: "菜单与浮层不透明度", exact: true })).toHaveValue("25");
	await expect(table.getByRole("spinbutton", { name: "弹窗不透明度", exact: true })).toHaveValue("35");
	await expect(page.locator(".app")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

	await settings(page).getByRole("button", { name: "关闭面板", exact: true }).click();
	await page.reload();
	await page.locator(".workspace-select").first().click();
	await expect(page.locator(".workspace-options")).toHaveCSS("background-color", alpha(25));
	await expect(page.locator(".workspace-options")).toHaveCSS("backdrop-filter", `blur(${defaults.floating.blur}px) saturate(${defaults.floating.saturation / 100})`);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await toggle.check();
	await expect(blur).toBeEditable();
	await expect(page.locator(".sidebar")).toHaveCSS("backdrop-filter", sidebarFilter);
	await settings(page).getByRole("button", { name: "保存", exact: true }).click();
	await expect(settings(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
	for (const selector of surfaces) await expect(page.locator(selector)).toHaveCSS("backdrop-filter", "none");
	await expect(settings(page)).not.toHaveCSS("background-color", translucent);
	await expect(blur).toBeHidden();
	await expect(page.locator(".app")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("仅重置可见的不透明度，隐藏的材质参数在关闭桌面透明后恢复", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "configs", "gui.jsonc");
	const materials = {
		sidebar: { opacity: 55, darkOpacity: 91, blur: 18, saturation: 140 },
		floating: { opacity: 25, blur: 30, saturation: 125 },
		dialog: { opacity: 35, blur: 12, saturation: 95 },
	};
	await writeFile(file, JSON.stringify({ theme: "light", materials }));
	await page.emulateMedia({ colorScheme: "light" });
	await page.reload();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	const opacity = settings(page).getByRole("spinbutton", { name: "左侧栏不透明度", exact: true });
	const reset = settings(page).getByRole("button", { name: "重置左侧栏材质", exact: true, includeHidden: true });
	await expect(opacity).toHaveValue("55");
	await reset.click();
	await expect(opacity).toHaveValue(String(defaults.sidebar.opacity));
	await expect(reset).toBeDisabled();
	await settings(page).getByRole("button", { name: "保存", exact: true }).click();
	await expect(settings(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
	expect(parse(await readFile(file, "utf8"))).toEqual({ theme: "light", materials: {
		...materials, sidebar: { darkOpacity: 91, blur: 18, saturation: 140 },
	} });
	await settings(page).getByRole("checkbox", { name: "桌面背景透明", exact: true }).uncheck();
	await settings(page).getByRole("button", { name: "保存", exact: true }).click();
	for (const [name, value] of [["左侧栏模糊", "18"], ["左侧栏饱和度", "140"], ["菜单与浮层不透明度", "25"], ["菜单与浮层模糊", "30"], ["菜单与浮层饱和度", "125"], ["弹窗不透明度", "35"], ["弹窗模糊", "12"], ["弹窗饱和度", "95"]] as const) {
		await expect(settings(page).getByRole("spinbutton", { name, exact: true })).toHaveValue(value);
	}
	await expect(reset).toBeEnabled();
});
