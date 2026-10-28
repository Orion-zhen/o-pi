import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "jsonc-parser";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixture.ts";
import { selectSettingsCategory } from "./settings-steps.ts";

async function open(page: Page) {
	if ((page.viewportSize()?.width ?? 1200) < 768) await page.getByRole("button", { name: "菜单", exact: true }).click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	return page.getByRole("dialog", { name: "设置", exact: true });
}

test("GUI 源码编辑支持高亮、缩进、撤销，切回表单后统一保存", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "configs", "gui.jsonc");
	await writeFile(file, "{}\n");
	const panel = await open(page);
	await panel.getByRole("button", { name: "JSONC", exact: true }).click();
	const source = panel.getByRole("textbox", { name: "GUI 设置 JSONC", exact: true });
	await expect(page.getByRole("dialog")).toHaveCount(1);
	await expect(panel.getByRole("combobox", { name: "主题", exact: true })).toHaveCount(0);
	const content = '{\n\t// 注释\n\t"theme": "dark",\n\t"sendShortcut": "enter"\n}\n';
	await source.fill(content);
	await expect(panel.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
	await expect(source.locator("span").filter({ hasText: '"dark"' })).toBeVisible();
	await expect(panel.locator(".cm-lineNumbers")).toBeVisible();
	await source.press("ControlOrMeta+Home");
	await source.press("ArrowDown");
	await source.press("Tab");
	await expect.poll(() => source.locator(".cm-line").nth(1).textContent()).toBe("\t\t// 注释");
	await source.press("ControlOrMeta+z");
	await expect.poll(() => source.locator(".cm-line").nth(1).textContent()).toBe("\t// 注释");
	expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await panel.getByRole("button", { name: "表单", exact: true }).click();
	await expect(panel.getByRole("combobox", { name: "主题", exact: true })).toHaveText("深色");
	await panel.getByRole("button", { name: "JSONC", exact: true }).click();
	await panel.getByRole("button", { name: "保存", exact: true }).click();
	await expect(panel.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
	expect(await readFile(file, "utf8")).toBe(content);
});

test("会话配置源码保存后写入文件并更新会话表单", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "settings.json");
	const panel = await open(page);
	await selectSettingsCategory(page, "对话与输入");
	await panel.getByRole("region", { name: "消息队列", exact: true }).getByRole("button", { name: "JSON", exact: true }).click();
	const source = panel.getByRole("textbox", { name: "设置 JSON", exact: true });
	await expect(source).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(1);
	const original = await readFile(file, "utf8");
	const content = JSON.stringify({ ...JSON.parse(original), images: { autoResize: false } }, null, 2);
	await source.fill(content);
	await panel.getByRole("button", { name: "保存", exact: true }).click();
	await expect(panel.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
	expect(parse(await readFile(file, "utf8"))).toMatchObject({ images: { autoResize: false } });
	await panel.getByRole("button", { name: "表单", exact: true }).click();
	await expect(panel.getByRole("switch", { name: "自动缩放图片", exact: true })).not.toBeChecked();
});
