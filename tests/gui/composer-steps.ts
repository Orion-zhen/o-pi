import { expect, type Page } from "@playwright/test";

export async function exerciseSuggestions(page: Page) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const suggestions = page.getByRole("list", { name: "输入建议", exact: true });
	await editor.fill("/gui-n");
	await suggestions.getByRole("button", { name: /^\/gui-note / }).click();
	await suggestions.getByRole("button", { name: "todo", exact: true }).click();
	await expect(editor).toHaveValue("/gui-note todo");
	await editor.fill("@inp");
	await editor.press("Tab");
	await suggestions.getByRole("button", { name: "input.ts", exact: true }).click();
	await expect(editor).toHaveValue('@"input.ts" ');
	await editor.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true });
	await expect(page.locator(".message.user")).toHaveCount(0);
}

export async function exerciseComposerRunning(page: Page) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const send = page.getByRole("button", { name: "发送", exact: true });
	await editor.fill("验证停止输出");
	await send.click();
	const tool = page.locator('.tool-activity[data-tool="bash"]');
	await expect(tool).toHaveAttribute("data-state", "running");
	await editor.fill("引导消息");
	await send.click();
	await page.getByRole("button", { name: /^当前：Steering/ }).click();
	await editor.fill("跟进消息");
	await send.click();
	const queue = page.getByRole("list", { name: "待发送消息", exact: true });
	await expect(queue.locator(".queue-message")).toHaveText(["引导消息", "跟进消息"]);
	await expect(queue.locator(".queue-kind")).toHaveText(["引导", "跟进"]);
	await page.getByRole("button", { name: "清空队列", exact: true }).click();
	await expect(queue).toHaveCount(0);
	await page.getByRole("button", { name: "停止", exact: true }).click();
	await expect(tool).not.toHaveAttribute("data-state", "running");
	await expect(send).toBeDisabled();
}
