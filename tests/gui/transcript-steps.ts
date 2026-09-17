import { expect, type Page } from "@playwright/test";

export async function exerciseLiveTranscript(page: Page) {
	const processGroup = page.locator(".reply-process").first();
	await expect(processGroup).toHaveAttribute("data-state", "open");
	const tool = page.locator('.tool-activity[data-tool="bash"]');
	await expect(tool).toHaveAttribute("data-state", "running");
	await tool.locator(".activity-summary").click();
	await expect(tool.locator('.code-block pre[aria-label="输出"]')).toContainText("GUI stream started");
	await page.locator(".transcript").evaluate((element) => { element.scrollTop = 0; });
	await expect(page.getByRole("button", { name: "回到最新" })).toBeVisible();
	await expect(tool.locator('.code-block pre[aria-label="输出"]')).toContainText("GUI stream update");
	expect(await page.locator(".transcript").evaluate((element) => element.scrollTop)).toBeLessThan(4);
	await expect(tool).toHaveAttribute("data-state", "completed");
	await expect(tool.locator(".activity-summary")).toHaveAttribute("aria-expanded", "true");
	await expect(tool.locator('.code-block pre[aria-label="输出"]')).toContainText("GUI shell complete");
	await expect(page.locator(".assistant-reply").first()).toHaveAttribute("data-state", "completed");
	await expect(processGroup).not.toHaveAttribute("data-state", "open");
	await expect(processGroup.locator(".tool-activity").first()).not.toBeVisible();
	await expect(page.locator(".reply-answer").first()).toContainText("GUI 验证完成");
}

export async function exerciseToolDetails(page: Page) {
	const processGroup = page.locator(".reply-process").first();
	await expect(processGroup).not.toHaveAttribute("data-state", "open");
	await processGroup.locator(":scope > .disclosure-trigger").click();
	await expect(processGroup.getByText("我先检查图片和源码。", { exact: true })).toBeVisible();
	await expect(processGroup.getByText("文件已定位，接下来验证修改和命令输出。", { exact: true })).toBeVisible();
	await expect(page.locator(".reply-answer")).not.toContainText("文件已定位");
	await expect(page.locator(".tool-activity")).toHaveCount(7);
	const thought = page.locator(".activity-thinking");
	await expect(thought).toHaveCount(1);
	await expect(thought).not.toHaveAttribute("data-state", "open");
	await thought.locator(".disclosure-trigger").click();
	await expect(thought).toContainText("先检查图片和源码");
	await thought.locator(".disclosure-trigger").click();

	const image = page.locator('.tool-activity[data-tool="read"]').first();
	await image.locator(".activity-summary").click();
	await expect(image.getByAltText("会话图片")).toBeVisible();
	await image.locator(".activity-summary").click();

	const read = page.locator('.tool-activity[data-tool="read"]').last();
	await read.locator(".activity-summary").click();
	await expect(read.locator("pre").first()).toContainText("export function hello()");
	await read.getByRole("button", { name: /复制.*input.ts/ }).click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("export function hello()");
	await read.locator(".tool-parameters > .disclosure-trigger").click();
	await expect(read.locator(".parameter-fields")).toContainText("input.ts");
	await read.locator(".tool-parameters > .disclosure-trigger").click();
	await read.locator(".activity-summary").click();

	const grep = page.locator('.tool-activity[data-tool="grep"]');
	await grep.locator(".activity-summary").click();
	await expect(grep.locator(".search-result").first()).toContainText("hello");
	await grep.locator(".activity-summary").click();

	const edit = page.locator('.tool-activity[data-tool="edit"]');
	await edit.locator(".activity-summary").click();
	await expect(edit.locator("pre").first()).toContainText("GUI fixture");
	await expect(edit.locator("pre").first()).toContainText("GUI updated");

	const echo = page.locator('.tool-activity[data-tool="echo"]');
	await echo.locator(".activity-summary").click();
	await echo.locator(".tool-parameters > .disclosure-trigger").click();
	await expect(echo.locator(".parameter-fields")).toContainText("扩展工具输出");
	await expect(echo.locator('.code-block pre[aria-label="输出"]')).toHaveText("扩展工具输出");
	await echo.locator(".activity-summary").click();

	const shell = page.locator('.tool-activity[data-tool="bash"]');
	await shell.locator(".activity-summary").click();
	await page.locator(".transcript").evaluate((element) => { element.scrollTop = 0; });
	await processGroup.locator(":scope > .disclosure-trigger").click();
	await expect(edit).not.toBeVisible();
	await expect(page.locator(".reply-answer")).toBeVisible();
	await processGroup.locator(":scope > .disclosure-trigger").click();
	await expect(edit.locator(".activity-summary")).toHaveAttribute("aria-expanded", "true");

	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	await editor.fill("只回复下一轮");
	await page.keyboard.press("ControlOrMeta+Enter");
	await expect(page.getByRole("main").getByText("第二轮独立回复", { exact: true })).toBeVisible();
	await expect(page.locator(".assistant-reply")).toHaveCount(2);
	await expect(processGroup).toHaveAttribute("data-state", "open");
	await expect(page.locator(".reply-process").last()).toBeHidden();
	await processGroup.locator(":scope > .disclosure-trigger").click();
	const viewport = page.locator(".transcript");
	const viewportHeight = await viewport.evaluate((element) => {
		element.scrollTop = 0;
		return element.clientHeight;
	});
	const latest = page.getByRole("button", { name: "回到最新", exact: true });
	await expect(latest).toBeVisible();
	const viewportBounds = await viewport.boundingBox();
	const buttonBounds = await latest.boundingBox();
	if (!viewportBounds || !buttonBounds) throw new Error("聊天区域或回到最新按钮不可见");
	expect(buttonBounds.y).toBeGreaterThanOrEqual(viewportBounds.y);
	expect(buttonBounds.y + buttonBounds.height).toBeLessThanOrEqual(viewportBounds.y + viewportBounds.height);
	expect(await viewport.evaluate((element) => element.clientHeight)).toBe(viewportHeight);
	const movement = await latest.evaluate((button) => {
		if (!(button instanceof HTMLButtonElement)) throw new Error("回到最新入口不是按钮");
		const viewport = document.querySelector(".transcript");
		if (!viewport) throw new Error("聊天滚动区域不存在");
		const start = viewport.scrollTop;
		const target = viewport.scrollHeight - viewport.clientHeight;
		return new Promise<{ start: number; immediate: number; intermediate: boolean }>((resolve) => {
			let frame = 0;
			let intermediate = false;
			const sample = () => {
				intermediate ||= viewport.scrollTop > start && viewport.scrollTop < target - 1;
				frame = requestAnimationFrame(sample);
			};
			viewport.addEventListener("scrollend", () => {
				cancelAnimationFrame(frame);
				resolve({ start, immediate, intermediate });
			}, { once: true });
			button.click();
			const immediate = viewport.scrollTop;
			frame = requestAnimationFrame(sample);
		});
	});
	expect(movement.immediate).toBe(movement.start);
	expect(movement.intermediate).toBe(true);
	await expect(page.locator(".jump-latest-region")).toHaveCount(0);
	expect(await viewport.evaluate((element) => element.clientHeight)).toBe(viewportHeight);
	await expect.poll(() => viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
}
