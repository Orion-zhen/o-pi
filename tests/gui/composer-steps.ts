import { expect, type Page } from "@playwright/test";
import { exerciseSuggestionKeyboard } from "./suggestion-keyboard-steps.ts";

export async function exerciseSuggestions(page: Page) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const suggestions = page.getByRole("list", { name: "输入建议", exact: true });
	const rows = suggestions.getByRole("listitem");
	await editor.fill("/gui-n");
	await expect(rows).toHaveCount(1);
	await suggestions.getByRole("button", { name: /^\/gui-note / }).click();
	await expect(editor).toHaveValue("/gui-note ");
	await expect(editor).toBeFocused();
	await suggestions.getByRole("button", { name: "todo", exact: true }).click();
	await expect(editor).toHaveValue("/gui-note todo");
	await editor.fill("@inp");
	await editor.press("Tab");
	await suggestions.getByRole("button", { name: "input.ts", exact: true }).click();
	await expect(editor).toHaveValue('@"input.ts" ');
	await expect(rows).toHaveCount(0);
	await editor.fill("/no-such-command");
	await expect(rows).toHaveCount(0);
	await exerciseSuggestionKeyboard(page);
	await editor.fill("");
}

export async function exerciseContextUsage(page: Page) {
	const usage = page.getByRole("button", { name: /^上下文占用 / });
	await usage.click();
	const details = page.getByRole("dialog", { name: "上下文详情", exact: true });
	await expect(details).toBeVisible();
	await expect(details).toContainText("128,000");
	await page.keyboard.press("Escape");
	await expect(details).toHaveCount(0);
	await expect(usage).toBeFocused();
}

export async function exerciseComposerRunning(page: Page, imagePath: string) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const send = page.getByRole("button", { name: "发送", exact: true });
	const stop = page.getByRole("button", { name: "停止", exact: true });
	await editor.fill("验证停止输出");
	await send.click();
	const tool = page.locator('.tool-activity[data-tool="bash"]').last();
	await expect(tool).toHaveAttribute("data-state", "running");
	await expect(page.getByRole("combobox", { name: "模型", exact: true })).toBeDisabled();
	await expect(page.getByRole("combobox", { name: "思考级别", exact: true })).toBeDisabled();
	await expect(stop).toBeEnabled();
	await expect(send).toHaveCount(0);
	await page.getByLabel("上传附件", { exact: true }).setInputFiles(imagePath);
	await expect(send).toBeEnabled();
	await expect(stop).toHaveCount(0);
	await page.getByRole("button", { name: "移除附件 1", exact: true }).click();
	await expect(stop).toBeEnabled();
	const messages = ["排队验证\n保留换行", "第二条排队消息", "第二条排队消息"];
	for (const text of messages) {
		await editor.fill(text);
		await send.click();
		await expect(editor).toHaveValue("");
	}
	const queue = page.getByRole("list", { name: "待发送消息", exact: true });
	await expect(queue.getByRole("listitem")).toHaveCount(3);
	await expect(queue.locator(".queue-message")).toHaveText(messages, { useInnerText: true });
	await expect(queue.locator(".queue-kind")).toHaveText(["跟进", "跟进", "跟进"]);
	await page.getByLabel("上传附件", { exact: true }).setInputFiles(imagePath);
	await send.click();
	await expect(queue.getByRole("listitem")).toHaveCount(4);
	await expect(queue.getByRole("listitem").last()).toContainText("（无文本）");
	const toggle = page.getByRole("button", { name: "待发送消息 (4)", exact: true });
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(queue).toHaveCount(0);
	await toggle.click();
	await expect(queue.getByRole("listitem")).toHaveCount(4);
	await expect(stop).toBeEnabled();
	await page.getByRole("button", { name: "清空队列", exact: true }).click();
	await expect(page.locator(".queue")).toHaveCount(0);
	await stop.click();
	await expect(stop).toHaveCount(0);
	await expect(send).toBeDisabled();
	await expect(tool).not.toHaveAttribute("data-state", "running");
}
