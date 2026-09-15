import { expect, type Page } from "@playwright/test";

export async function exerciseReports(page: Page) {
	for (const [command, title, heading] of [
		["/stats", "会话统计", "上下文窗口"],
		["/usage", "套餐用量", "套餐用量"],
		["/system", "系统提示词", "系统提示词"],
		["/telemetry", "遥测", "工具运行概览"],
	] as const) {
		await page.getByRole("textbox", { name: "消息", exact: true }).fill(command);
		await page.getByRole("button", { name: "发送", exact: true }).click();
		const panel = page.getByRole("dialog", { name: title, exact: true });
		await expect(panel.getByRole("heading", { name: heading, exact: true })).toBeVisible();
		if (command === "/system") {
			await expect(panel.locator("pre.system-prompt")).toContainText("<role>");
			await expect(panel.locator("pre.system-prompt")).toContainText("</role>");
			await expect(panel.locator("pre.system-prompt > *")).toHaveCount(0);
			await expect(panel.locator("pre.system-prompt")).toHaveCSS("white-space", "pre-wrap");
		} else await expect(panel.locator("pre")).toHaveCount(0);
		if (command === "/stats") {
			await expect(panel.locator(".report-metrics")).toContainText("累计 Token");
			await expect(panel.getByRole("meter", { name: "工具输出", exact: true })).toHaveCount(1);
		}
		if (command === "/usage") {
			await expect(panel).toContainText("暂无已登录的套餐。");
			await expect(panel.locator(".report-intro, .report-section")).toHaveCount(0);
			await expect(panel.getByRole("heading")).toHaveCount(1);
		}
		if (command === "/telemetry") {
			await expect(panel.getByRole("meter", { name: "read", exact: true })).toHaveCount(1);
			const grep = panel.locator("details").filter({ has: page.locator("summary", { hasText: /^Grep 管线$/ }) });
			await grep.locator("summary").first().click();
			await expect(grep).toHaveAttribute("open", "");
			await expect(grep).toContainText("直接命中");
		}
		expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		await panel.getByRole("button", { name: "关闭面板", exact: true }).click();
		await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
	}
}
