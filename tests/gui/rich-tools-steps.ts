import { expect, type Page } from "@playwright/test";

export async function exerciseRichTools(page: Page) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	await editor.fill("验证网页和子代理");
	await page.keyboard.press("ControlOrMeta+Enter");
	await expect(page.locator('.tool-activity[data-tool="websearch"]').last()).toHaveAttribute("data-state", "completed");
	await page.getByRole("button", { name: "Allow once", exact: true }).click();
	const agent = page.locator('.tool-activity[data-tool="subagent"]').last();
	await expect(agent).toHaveAttribute("data-state", "running");
	await expect(agent.locator(".activity-summary")).toHaveAttribute("aria-expanded", "true");
	const tasks = agent.locator(".subagent-task");
	await expect(tasks).toHaveCount(2);
	await expect(tasks.first()).toContainText("bash");
	await expect(tasks.last().locator(".subagent-current")).toContainText("bash");
	await tasks.first().locator(".subagent-task-summary").click();
	await tasks.first().locator(".subagent-events > .disclosure-trigger").click();
	await expect(tasks.first().locator(".subagent-events")).toHaveAttribute("data-state", "open");
	await expect(agent.locator("progress")).toHaveAttribute("value", "1");
	await expect(tasks.first()).toHaveAttribute("data-state", "running");
	await expect(tasks.last()).toHaveAttribute("data-state", "completed");
	await expect(tasks.last().locator(".subagent-current strong")).toHaveText("子代理检查完成");
	await expect(page.getByRole("main").getByText("网页与子代理验证完成。", { exact: true })).toBeVisible();
	const group = page.locator(".reply-process").last();
	await expect(group).not.toHaveAttribute("data-state", "open");
	await group.locator(":scope > .disclosure-trigger").click();
	await agent.locator(".activity-summary").click();
	await expect(agent.locator("progress")).toHaveAttribute("value", "2");
	await expect(tasks.first().locator(".subagent-task-summary")).toHaveAttribute("aria-expanded", "true");
	await expect(tasks.first().locator(".subagent-events")).toHaveAttribute("data-state", "open");
	await expect(tasks.first().locator(".subagent-output strong")).toHaveText("子代理检查完成");

	const search = page.locator('.tool-activity[data-tool="websearch"]').last();
	await search.locator(".activity-summary").click();
	await expect(search.locator(".web-card")).toHaveCount(2);
	await expect(search.getByRole("link", { name: /React 文档/ })).toHaveAttribute("href", "https://react.dev/learn");
	await expect(search.locator(".web-card-snippet").first()).toContainText("状态管理");
	const fetch = page.locator('.tool-activity[data-tool="webfetch"]').last();
	await fetch.locator(".activity-summary").click();
	await expect(fetch.locator(".web-card-title")).toHaveText("聊天界面设计");
	await expect(fetch.locator(".web-partial")).toBeVisible();
	await fetch.locator(".web-preview > .disclosure-trigger").click();
	await expect(fetch.locator(".web-preview-content")).toContainText("让用户专注于最终回复");
	await expect(fetch.locator("img, iframe")).toHaveCount(0);
	await group.locator(":scope > .disclosure-trigger").click();

	await editor.fill('/run gui-scout "GUI子任务：检查面板"');
	await page.keyboard.press("ControlOrMeta+Enter");
	const panel = page.getByRole("dialog", { name: "子代理任务", exact: true });
	await expect(panel.locator(".subagent-task")).toHaveAttribute("data-state", "running");
	await expect(panel.getByRole("button", { name: "停止子代理任务", exact: true })).toBeVisible();
	await expect(panel.locator(".subagent-task")).toHaveAttribute("data-state", "completed");
	await panel.getByRole("button", { name: "关闭面板", exact: true }).click();

	await editor.fill('/run gui-scout "GUI子任务：检查取消" | gui-scout "GUI子任务：后续 {previous}"');
	await page.keyboard.press("ControlOrMeta+Enter");
	await expect(panel.locator(".subagent-task").first()).toHaveAttribute("data-state", "running");
	await expect(panel.locator(".subagent-task").last()).toHaveAttribute("data-state", "pending");
	await panel.getByRole("button", { name: "停止子代理任务", exact: true }).click();
	await expect(panel.locator(".subagent-task").first()).toHaveAttribute("data-state", "stopped");
	await expect(panel.locator(".subagent-task").last()).toHaveAttribute("data-state", "skipped");
	await expect(panel.getByRole("button", { name: "停止子代理任务", exact: true })).toHaveCount(0);
	await panel.getByRole("button", { name: "关闭面板", exact: true }).click();
}
