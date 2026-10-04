import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "jsonc-parser";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixture.ts";
import { selectSettingsCategory } from "./settings-steps.ts";

const settings = (page: Page) => page.getByRole("dialog", { name: "设置", exact: true });
async function open(page: Page) {
	if ((page.viewportSize()?.width ?? 1200) < 768) await page.getByRole("button", { name: "菜单", exact: true }).click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
}
async function expectRows(section: Locator, count: number) {
	const rows = section.locator(".preference-row");
	await expect(rows).toHaveCount(count);
	const bounds = await rows.evaluateAll((elements) => elements.map((element) => {
		const { top, bottom, left, right } = element.getBoundingClientRect();
		return { top, bottom, left, right };
	}));
	for (let index = 1; index < bounds.length; index++) {
		const previous = bounds[index - 1];
		const current = bounds[index];
		if (!previous || !current) throw new Error("缺少设置行");
		expect(current.top).toBeGreaterThanOrEqual(previous.bottom - 1);
		expect(Math.abs(current.left - previous.left)).toBeLessThan(1);
		expect(Math.abs(current.right - previous.right)).toBeLessThan(1);
	}
}

test("设置按章节分组、逐行排列，所有布尔项使用无启用前缀的开关", async ({ gui: { page } }) => {
	await open(page);
	await expect(settings(page).getByRole("switch", { name: "磨砂材质", exact: true })).toBeVisible();
	await expectRows(settings(page).getByRole("region", { name: "主题与颜色", exact: true }), 2);
	await expectRows(settings(page).getByRole("region", { name: "字体与字号", exact: true }), 5);
	await expectRows(settings(page).getByRole("region", { name: "磨砂与透明", exact: true }), 2);
	for (const colorScheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme });
		await settings(page).getByRole("heading", { name: "外观", exact: true }).scrollIntoViewIfNeeded();
		await settings(page).screenshot({ path: test.info().outputPath(`settings-${colorScheme}.png`), animations: "disabled" });
	}
	for (const category of ["外观", "对话与输入", "工具与代码", "网络与网页", "子代理", "权限与安全", "连接与集成", "终端界面"]) {
		await selectSettingsCategory(page, category);
		const content = settings(page).getByRole("tabpanel", { name: category, exact: true });
		await expect(content.getByRole("switch").first()).toBeAttached();
		await expect(content.getByRole("checkbox", { includeHidden: true })).toHaveCount(0);
		await expect(content.getByRole("switch", { name: /启用/, includeHidden: true })).toHaveCount(0);
		await expect(content.locator(".preference-label").filter({ hasText: "启用" })).toHaveCount(0);
		expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	}
});

test("开关支持键盘、禁用联动、放弃草稿和跨分类保存", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "configs", "gui.jsonc");
	await writeFile(file, "{}\n");
	await open(page);
	const panel = settings(page);
	const material = panel.getByRole("switch", { name: "磨砂材质", exact: true });
	await expect(material).toBeChecked();
	await material.press("Space");
	await expect(material).not.toBeChecked();
	await expect(panel.getByRole("switch", { name: "桌面背景透明", exact: true })).toBeDisabled();
	await panel.getByRole("button", { name: "放弃", exact: true }).click();
	await expect(material).toBeChecked();
	await expect(panel.getByRole("switch", { name: "桌面背景透明", exact: true })).toBeEnabled();

	await selectSettingsCategory(page, "连接与集成");
	const web = panel.getByRole("switch", { name: "Web 访问", exact: true });
	await expect(web).not.toBeChecked();
	await expect(panel.getByRole("textbox", { name: "监听地址", exact: true })).toBeDisabled();
	await web.press("Space");
	await expect(panel.getByRole("textbox", { name: "监听地址", exact: true })).toBeEnabled();

	await selectSettingsCategory(page, "网络与网页");
	const proxy = panel.getByRole("switch", { name: "代理", exact: true });
	await proxy.check();
	await expect(panel.getByRole("textbox", { name: "HTTP 代理", exact: true })).toBeEnabled();
	await selectSettingsCategory(page, "对话与输入");
	const resize = panel.getByRole("switch", { name: "自动缩放图片", exact: true });
	const original = await resize.isChecked();
	await resize.press("Space");
	await expect(resize).toBeChecked({ checked: !original });
	expect(parse(await readFile(file, "utf8"))).toEqual({});
	const save = panel.getByRole("button", { name: "保存", exact: true });
	await save.click();
	await expect(panel.locator(".settings-actions").getByRole("status")).toHaveText("已保存");
	await expect(save).toBeDisabled();
	expect(parse(await readFile(file, "utf8"))).toMatchObject({ desktopWeb: { enabled: true } });

	await page.reload();
	await open(page);
	await selectSettingsCategory(page, "连接与集成");
	await expect(web).toBeChecked();
	await selectSettingsCategory(page, "网络与网页");
	await expect(proxy).toBeChecked();
	await selectSettingsCategory(page, "对话与输入");
	await expect(resize).toBeChecked({ checked: !original });
});
