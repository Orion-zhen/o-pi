import { expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function exerciseTooltips(page: Page, cwd: string) {
	const tooltip = page.getByRole("tooltip").and(page.locator(':not([data-state="closed"])'));
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const counter = page.locator(".tool-count");
	await counter.hover();
	await expect(tooltip).toHaveText("工具 · 普通模式");
	await expect(page.locator("[title]")).toHaveCount(0);
	await editor.click();
	await counter.focus();
	await expect(tooltip).toHaveText("工具 · 普通模式");
	await counter.press("Escape");
	await expect(tooltip).toHaveCount(0);
	await counter.click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(tooltip.filter({ hasText: "工具 · 普通模式" })).toHaveCount(0);
	await page.getByRole("button", { name: "关闭面板", exact: true }).click();

	const workspace = page.locator(".workspace-select").first();
	await workspace.hover();
	await expect(tooltip).toHaveText(cwd);
	await workspace.click();
	await expect(page.getByRole("listbox", { name: "工作区列表" })).toBeVisible();
	await expect(tooltip).toHaveCount(0);
	await page.keyboard.press("Escape");

	const filename = `tooltip_${"long-path-".repeat(18)}.ts`;
	await writeFile(path.join(cwd, filename), "export {};\n");
	await editor.fill("@tooltip_");
	await editor.press("Tab");
	const suggestion = page.getByRole("button", { name: filename, exact: true });
	await suggestion.hover();
	await expect(tooltip).toHaveText(filename);
	const bounds = await tooltip.boundingBox();
	if (!bounds) throw new Error("缺少提示边界");
	expect(bounds.width).toBeLessThanOrEqual(384);
	expect(bounds.x).toBeGreaterThanOrEqual(0);
	expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
	await suggestion.click();
	await expect(tooltip).toHaveCount(0);

	await editor.fill("验证悬停提示");
	await editor.press("ControlOrMeta+Enter");
	await expect(page.locator(".reply-answer")).toContainText("GUI 验证完成");
	await page.locator(".assistant-reply > .reply-process > .disclosure-trigger").click();
	await page.locator(".reply-activity:has(.activity-summary) > .disclosure-trigger").first().click();
	const summary = page.locator('.activity-summary[data-tool-name="read"]');
	await summary.hover();
	await expect(tooltip).toHaveText("read");
	await summary.locator(".activity-target").hover();
	await expect(tooltip).toHaveText("read");
	await summary.click();
	await expect(tooltip).toHaveCount(0);

	const row = page.locator(".history-session-row").first();
	await row.hover();
	const remove = row.getByRole("button", { name: /^删除会话 / });
	await remove.hover();
	await expect(tooltip).toHaveText("永久删除");
	await remove.click();
	const confirm = row.getByRole("button", { name: /^确认删除会话 / });
	await expect(confirm).toHaveAttribute("data-confirming", "true");
	await page.mouse.move(0, 0);
	await confirm.hover();
	await expect(tooltip).toHaveText("确认删除");
	await confirm.press("Escape");
	await expect(remove).toHaveAttribute("data-confirming", "false");

	const handle = page.getByRole("separator", { name: "调整左侧栏宽度", exact: true });
	await handle.hover();
	await expect(tooltip).toHaveText("拖动调整 · 双击重置");
	await page.mouse.down();
	await expect(tooltip).toHaveCount(0);
	await page.mouse.up();
	await handle.press("Home");
	await expect(page.locator("[title]")).toHaveCount(0);
}
