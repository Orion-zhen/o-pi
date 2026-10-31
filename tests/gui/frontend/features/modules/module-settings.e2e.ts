import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "jsonc-parser";
import type { Page } from "@playwright/test";
import { test, expect } from "../../../helpers/fixture.ts";
import { selectSetting, selectSettingsCategory } from "../../../helpers/settings-steps.ts";

const settings = (page: Page) => page.getByRole("dialog", { name: "设置", exact: true });
async function open(page: Page, category: string) {
	if ((page.viewportSize()?.width ?? 1200) < 768) await page.getByRole("button", { name: "菜单", exact: true }).click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await selectSettingsCategory(page, category);
}
async function save(page: Page) {
	await settings(page).getByRole("button", { name: "保存", exact: true }).click();
	await expect(settings(page).locator(".settings-actions").getByRole("status")).toHaveAccessibleName("已保存");
}
async function expectOptions(page: Page, label: string, options: string[]) {
	const control = settings(page).getByRole("radiogroup", { name: label, exact: true });
	await expect(control.getByRole("radio")).toHaveCount(options.length);
	for (const option of options) await expect(control.getByRole("radio", { name: option, exact: true })).toBeVisible();
}

test("模块下拉框采用 schema 选项，网页图片开启可保存、刷新和重置", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "configs", "web-tools.jsonc");
	await writeFile(file, "{}\n");
	await open(page, "网络与网页");
	await expectOptions(page, "网页图片", ["auto", "on", "off"]);
	await expectOptions(page, "发送 Cookie 前询问", ["每次询问", "每个会话询问", "不询问"]);
	await selectSetting(page, "网页图片", "on");
	await save(page);
	expect(parse(await readFile(file, "utf8"))).toEqual({ webfetch: { media: { mode: "on" } } });
	await selectSettingsCategory(page, "权限与安全");
	for (const label of ["写入文件", "编辑文件", "读取网页", "执行命令"]) await expectOptions(page, label, ["allow", "ask", "deny"]);
	await selectSettingsCategory(page, "工具与代码");
	await expectOptions(page, "诊断级别", ["error", "warning", "information", "hint"]);
	await selectSettingsCategory(page, "终端界面");
	await expectOptions(page, "图标", ["unicode", "ascii", "nerd"]);

	await page.reload();
	await open(page, "网络与网页");
	await expect(settings(page).getByRole("radiogroup", { name: "网页图片", exact: true }).getByRole("radio", { name: "on", exact: true })).toBeChecked();
	await settings(page).getByRole("button", { name: "重置网页图片", exact: true }).click();
	await expect(settings(page).getByRole("radiogroup", { name: "网页图片", exact: true }).getByRole("radio", { name: "auto", exact: true })).toBeChecked();
	await save(page);
	expect(parse(await readFile(file, "utf8"))).not.toHaveProperty("webfetch.media.mode");
});

test("Discord 展示内容来自配置，JSON 草稿中的自定义名称不被丢弃", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "configs", "discord-presence.jsonc");
	await writeFile(file, '{"enabled":false}\n');
	await open(page, "连接与集成");
	const section = settings(page).getByRole("region", { name: "Discord 状态", exact: true });
	await section.getByRole("button", { name: "JSONC", exact: true }).click();
	await section.getByRole("textbox", { name: "discordPresence 全局 JSONC", exact: true }).fill(JSON.stringify({
		enabled: true,
		profiles: { custom: { details: { idle: "Idle" }, state: "Custom", show_elapsed: false } },
	}));
	await section.getByRole("button", { name: "表单", exact: true }).click();
	await expectOptions(page, "展示内容", ["minimal", "standard", "detailed", "custom"]);
	await selectSetting(page, "展示内容", "custom");
	await section.getByRole("switch", { name: "显示 Discord 状态", exact: true }).uncheck();
	await save(page);
	expect(parse(await readFile(file, "utf8"))).toMatchObject({ enabled: false, profile: "custom", profiles: { custom: { state: "Custom" } } });
	await page.reload();
	await open(page, "连接与集成");
	await expect(section.getByRole("radiogroup", { name: "展示内容", exact: true }).getByRole("radio", { name: "custom", exact: true })).toBeChecked();
});
