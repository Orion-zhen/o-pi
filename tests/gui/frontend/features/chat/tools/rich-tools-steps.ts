import { expect, type Page } from "@playwright/test";

export async function exerciseRichTools(page: Page) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	await editor.fill("验证网页和子代理");
	await editor.press("ControlOrMeta+Enter");
	await page.getByRole("button", { name: "Allow once", exact: true }).click();
	await expect(page.locator(".reply-answer")).toContainText("网页与子代理验证完成");
	for (const name of ["websearch", "webfetch", "subagent"])
		await expect(page.locator(`.tool-activity[data-tool="${name}"]`)).toHaveAttribute("data-state", "completed");

	await editor.fill('/run gui-scout "GUI子任务：检查取消" | gui-scout "GUI子任务：后续 {previous}"');
	await editor.press("ControlOrMeta+Enter");
	const panel = page.getByRole("dialog", { name: "子代理任务", exact: true });
	await expect(panel.locator(".subagent-task").first()).toHaveAttribute("data-state", "running");
	await panel.getByRole("button", { name: "停止子代理任务", exact: true }).click();
	await expect(panel.locator(".subagent-task").first()).toHaveAttribute("data-state", "stopped");
	await expect(panel.locator(".subagent-task").last()).toHaveAttribute("data-state", "skipped");
}
