import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixture.ts";
import { selectSettingsCategory } from "./settings-steps.ts";

const panel = (page: Page) => page.getByRole("dialog", { name: "设置", exact: true });
async function open(page: Page) {
	if ((page.viewportSize()?.width ?? 1200) < 768) await page.getByRole("button", { name: "菜单", exact: true }).click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
}
async function expectDirty(page: Page, dirty: boolean) {
	for (const name of ["保存", "放弃"]) await expect(panel(page).getByRole("button", { name, exact: true })).toBeEnabled({ enabled: dirty });
}
test("主题色失焦提交与 JSONC 弹窗编辑回到原值后禁用保存", async ({ gui: { page }, workspace: { agentDir } }) => {
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
	const config = page.getByRole("dialog", { name: "gui.jsonc", exact: true });
	const apply = config.getByRole("button", { name: "保存并应用", exact: true });
	await expect(apply).toBeDisabled();
	const source = config.getByRole("textbox", { name: "GUI 设置 JSONC", exact: true });
	const originalSource = await source.inputValue();
	await source.fill(`\n${originalSource}`);
	await expect(apply).toBeEnabled();
	await source.fill(originalSource);
	await expect(apply).toBeDisabled();
	await config.getByRole("button", { name: "关闭面板", exact: true }).click();

});

test("源码编辑跨表单切换、保存和放弃后使用正确基准", async ({ gui: { page }, workspace: { agentDir } }) => {
	await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{}\n');
	await writeFile(path.join(agentDir, "mcp.json"), '{"mcpServers":{"one":{"command":"node","enabled":false}}}');
	await writeFile(path.join(agentDir, "models.json"), '{"providers":{"local":{"api":"openai-completions"}}}');
	await open(page);
	for (const [category, region, source, label, file] of [
		["对话与输入", "自动标题", "JSONC", "autoTitle 全局 JSONC", "configs/auto-title.jsonc"],
		["连接与集成", "MCP 服务", "JSON", "全局 MCP JSON", "mcp.json"],
		["模型服务", "OpenAI 兼容服务", "JSON", "模型服务 JSON", "models.json"],
	] as const) {
		await selectSettingsCategory(page, category);
		const section = panel(page).getByRole("region", { name: region, exact: true });
		await section.getByRole("button", { name: source, exact: true }).click();
		const editor = section.getByRole("textbox", { name: label, exact: true });
		const original = await editor.inputValue();
		await editor.fill(`\n${original}`);
		await expectDirty(page, true);
		await section.getByRole("button", { name: "表单", exact: true }).click();
		await expectDirty(page, true);
		await section.getByRole("button", { name: source, exact: true }).click();
		await editor.fill(original);
		await expectDirty(page, false);
		await section.getByRole("button", { name: "表单", exact: true }).click();
		if (category === "模型服务") {
			await section.getByRole("button", { name: "编辑服务 local", exact: true }).click();
			await section.getByRole("button", { name: "请求设置", exact: true }).click();
		}
		const toggle = section.getByRole("switch").first();
		await toggle.click();
		await expectDirty(page, true);
		await toggle.click();
		await expectDirty(page, false);
		await section.getByRole("button", { name: source, exact: true }).click();
		await editor.fill(`\n${original}`);
		await panel(page).getByRole("button", { name: "保存", exact: true }).click();
		await expectDirty(page, false);
		expect(await readFile(path.join(agentDir, file), "utf8")).toBe(`\n${original}`);
		await editor.fill(original);
		await expectDirty(page, true);
		await panel(page).getByRole("button", { name: "放弃", exact: true }).click();
		await expect(editor).toHaveValue(`\n${original}`);
		await expectDirty(page, false);
	}
});
