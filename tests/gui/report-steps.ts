import { expect, type Page } from "@playwright/test";

export async function exerciseReports(page: Page) {
	for (const [command, title] of [
		["/stats", "会话统计"], ["/usage", "套餐用量"], ["/system", "系统提示词"], ["/telemetry", "遥测"],
	] as const) {
		await page.getByRole("textbox", { name: "消息", exact: true }).fill(command);
		await page.getByRole("button", { name: "发送", exact: true }).click();
		const docked = command === "/stats" || command === "/telemetry";
		const panel = docked ? page.getByRole("complementary", { name: "会话信息", exact: true }) : page.getByRole("dialog", { name: title, exact: true });
		await expect(panel).toBeVisible();
		if (docked) await expect(panel.getByRole("tab", { name: title, exact: true })).toHaveAttribute("aria-selected", "true");
		if (command === "/system") await expect(panel.locator("pre.system-prompt")).not.toBeEmpty();
		if (command === "/stats") await expect(panel.getByRole("meter", { name: "工具输出", exact: true })).toHaveCount(1);
		if (command === "/usage") await expect(panel.locator("meter")).toHaveCount(0);
		if (command === "/telemetry") {
			await expect(panel.getByRole("meter", { name: "read", exact: true })).toHaveCount(1);
			const grep = panel.locator("details").filter({ has: page.locator("summary", { hasText: /^Grep 管线$/ }) });
			await grep.locator("summary").first().click();
			await expect(grep).toHaveAttribute("open", "");
			await expect(grep.getByRole("meter", { name: "直接命中", exact: true })).toBeVisible();
		}
		await (docked ? page : panel).getByRole("button", { name: docked ? "收起会话信息" : "关闭面板", exact: true }).click();
		await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
	}
}
