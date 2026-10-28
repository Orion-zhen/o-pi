import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixture.ts";

const panel = (page: Page) => page.getByRole("dialog", { name: "设置", exact: true });
async function open(page: Page) {
	if ((page.viewportSize()?.width ?? 1200) < 768) await page.getByRole("button", { name: "菜单", exact: true }).click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
}
async function expectDirty(page: Page, dirty: boolean) {
	for (const name of ["保存", "放弃"]) await expect(panel(page).getByRole("button", { name, exact: true })).toBeEnabled({ enabled: dirty });
}
test("主题色失焦提交与原位 JSONC 编辑回到原值后禁用保存", async ({ gui: { page }, workspace: { agentDir } }) => {
	await writeFile(path.join(agentDir, "configs", "gui.jsonc"), "{}\n");
	await open(page);

	await panel(page).getByRole("button", { name: "主题色", exact: true }).click();
	const picker = page.getByLabel("主题色调色板", { exact: true });
	const color = picker.getByRole("textbox", { name: "主题色 HEX", exact: true });
	const originalColor = await color.inputValue();
	await color.fill("#123456");
	await color.press("Tab");
	await expectDirty(page, true);
	await color.fill(originalColor.toLowerCase());
	await color.press("Tab");
	await expectDirty(page, false);
	await expect(picker.getByRole("button", { name: "重置主题色", exact: true })).toBeHidden();
	await page.keyboard.press("Escape");

	await panel(page).getByRole("button", { name: "JSONC", exact: true }).click();
	const config = panel(page);
	await expect(page.getByRole("dialog")).toHaveCount(1);
	const apply = config.getByRole("button", { name: "保存", exact: true });
	await expect(apply).toBeDisabled();
	const source = config.getByRole("textbox", { name: "GUI 设置 JSONC", exact: true });
	const originalSource = "{}\n";
	await source.fill(`\n${originalSource}`);
	await expect(apply).toBeEnabled();
	await source.fill(originalSource);
	await expect(apply).toBeDisabled();
	await config.getByRole("button", { name: "表单", exact: true }).click();
	await expect(config.getByRole("combobox", { name: "主题", exact: true })).toBeVisible();
});
