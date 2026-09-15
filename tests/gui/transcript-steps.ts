import { expect, type Page } from "@playwright/test";
import path from "node:path";

export async function exerciseLiveTranscript(page: Page) {
	const processGroup = page.locator(".reply-process").first();
	await expect(processGroup).toHaveAttribute("open", "");
	const tool = page.locator('.tool-activity[data-tool="bash"]');
	await expect(tool).toHaveAttribute("data-state", "running");
	await tool.locator(".activity-summary").click();
	await expect(tool.locator('.code-block pre[aria-label="输出"]')).toContainText("GUI stream started");
	const node = await tool.elementHandle();
	if (!node) throw new Error("缺少执行中的工具节点");
	await page.locator(".transcript").evaluate((element) => { element.scrollTop = 0; });
	await expect(page.getByRole("button", { name: "回到最新" })).toBeVisible();
	await expect(tool.locator('.code-block pre[aria-label="输出"]')).toContainText("GUI stream update");
	expect(await page.locator(".transcript").evaluate((element) => element.scrollTop)).toBeLessThan(4);
	await expect(tool).toHaveAttribute("data-state", "completed");
	expect(await node.evaluate((element) => element.isConnected)).toBe(true);
	await expect(tool.locator(".activity-summary")).toHaveAttribute("aria-expanded", "true");
	await expect(tool.locator('.code-block pre[aria-label="输出"]')).toContainText("GUI shell complete");
	await expect(page.locator(".message.toolResult, .live-tool")).toHaveCount(0);
	await expect(page.locator(".assistant-reply").first()).toHaveAttribute("data-state", "completed");
	await expect(processGroup).not.toHaveAttribute("open", "");
	await expect(processGroup.locator(".tool-activity").first()).not.toBeVisible();
	await expect(page.locator(".reply-answer").first()).toContainText("GUI 验证完成");
	await node.dispose();
}

export async function exerciseToolDetails(page: Page) {
	const processGroup = page.locator(".reply-process").first();
	await expect(processGroup).not.toHaveAttribute("open", "");
	await expect(processGroup.locator(":scope > summary")).toContainText("7 次工具调用");
	await processGroup.locator(":scope > summary").click();
	await expect(processGroup.getByText("我先检查图片和源码。", { exact: true })).toBeVisible();
	await expect(processGroup.getByText("文件已定位，接下来验证修改和命令输出。", { exact: true })).toBeVisible();
	await expect(page.locator(".reply-answer")).not.toContainText("文件已定位");
	await expect(page.locator(".tool-activity")).toHaveCount(7);
	const thought = page.locator(".activity-thinking");
	await expect(thought).toHaveCount(1);
	await expect(thought).not.toHaveAttribute("open", "");
	await thought.locator("summary").click();
	await expect(thought).toContainText("先检查图片和源码");
	await thought.locator("summary").click();

	const image = page.locator('.tool-activity[data-tool="read"]').first();
	await image.locator(".activity-summary").click();
	await expect(image.getByAltText("会话图片")).toBeVisible();
	await image.locator(".activity-summary").click();

	const read = page.locator('.tool-activity[data-tool="read"]').last();
	await read.locator(".activity-summary").click();
	await expect(read.locator(".token.keyword").first()).toBeVisible();
	await expect(read.getByRole("button", { name: /复制.*input.ts/ })).toBeVisible();
	await read.getByRole("button", { name: /复制.*input.ts/ }).click();
	await expect(read.getByRole("button", { name: /复制.*input.ts/ })).toHaveText("已复制");
	await read.locator(".tool-parameters > summary").click();
	await expect(read.locator(".parameter-fields")).toContainText("路径");
	await expect(read.locator(".parameter-fields")).toContainText("行号");
	await read.locator(".tool-parameters > summary").click();
	await read.locator(".activity-summary").click();

	const grep = page.locator('.tool-activity[data-tool="grep"]');
	await grep.locator(".activity-summary").click();
	await expect(grep.locator(".search-result").first()).toContainText("hello");
	await grep.locator(".activity-summary").click();

	const edit = page.locator('.tool-activity[data-tool="edit"]');
	await edit.locator(".activity-summary").click();
	await expect(edit.locator(".token.deleted").first()).toBeVisible();
	await expect(edit.locator(".token.inserted").first()).toBeVisible();
	const lineBackground = (selector: string) => edit.locator(selector).first().evaluate((element) => {
		const line = element.closest(".diff-line");
		if (!line) throw new Error("缺少 diff 行");
		return getComputedStyle(line).backgroundColor;
	});
	expect(await lineBackground(".token.inserted.prefix")).not.toBe(await lineBackground(".token.deleted.prefix"));

	const echo = page.locator('.tool-activity[data-tool="echo"]');
	await echo.locator(".activity-summary").click();
	await echo.locator(".tool-parameters > summary").click();
	await expect(echo.locator(".parameter-fields")).toContainText("扩展工具输出");
	await expect(echo.locator('.code-block pre[aria-label="输出"]')).toHaveText("扩展工具输出");
	await echo.locator(".activity-summary").click();

	const shell = page.locator('.tool-activity[data-tool="bash"]');
	await shell.locator(".activity-summary").click();
	await page.locator(".transcript").evaluate((element) => { element.scrollTop = 0; });
	const size = await page.evaluate(() => Boolean(window.opi)) ? "electron" : (page.viewportSize()?.width ?? 1200) < 768 ? "phone" : "desktop";
	await page.screenshot({ animations: "disabled", path: path.join(process.cwd(), "dist", `gui-transcript-${size}.png`) });
	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
	await page.screenshot({ animations: "disabled", path: path.join(process.cwd(), "dist", `gui-transcript-dark-${size}.png`) });
	await page.emulateMedia({ colorScheme: "light" });
	await processGroup.locator(":scope > summary").click();
	await expect(edit).not.toBeVisible();
	await expect(page.locator(".reply-answer")).toBeVisible();
	await page.screenshot({ animations: "disabled", path: path.join(process.cwd(), "dist", `gui-reply-${size}.png`) });
	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
	await page.screenshot({ animations: "disabled", path: path.join(process.cwd(), "dist", `gui-reply-dark-${size}.png`) });
	await page.emulateMedia({ colorScheme: "light" });
	await processGroup.locator(":scope > summary").click();
	await expect(edit.locator(".activity-summary")).toHaveAttribute("aria-expanded", "true");

	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	await editor.fill("只回复下一轮");
	await page.keyboard.press("ControlOrMeta+Enter");
	await expect(page.getByText("第二轮独立回复", { exact: true })).toBeVisible();
	await expect(page.locator(".assistant-reply")).toHaveCount(2);
	await expect(processGroup).toHaveAttribute("open", "");
	await expect(page.locator(".reply-process").last()).toBeHidden();
	await processGroup.locator(":scope > summary").click();
	await page.locator(".transcript").evaluate((element) => { element.scrollTop = element.scrollHeight; });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
