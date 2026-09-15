import { expect, type Page } from "@playwright/test";

export async function exerciseContextUsage(page: Page) {
	const usage = page.getByRole("button", { name: /^上下文占用 / });
	await page.getByRole("textbox", { name: "消息", exact: true }).hover();
	await usage.hover();
	await expect(page.getByRole("tooltip", { name: /^上下文占用 / })).toBeVisible();
	await usage.click();
	const details = page.getByRole("dialog", { name: "上下文详情", exact: true });
	await expect(details).toBeVisible();
	await expect(details).toContainText("128,000");
	for (const label of ["已用 tokens", "上下文容量", "已启用工具", "累计 tokens", "预估费用", "最近命中率", "累计命中率", "缓存读取 tokens", "缓存写入 tokens"]) {
		await expect(details.getByText(label, { exact: true })).toBeVisible();
	}
	expect(await details.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
	await page.keyboard.press("Escape");
	await expect(details).toHaveCount(0);
	await expect(usage).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(details).toBeVisible();
	await page.getByRole("textbox", { name: "消息", exact: true }).focus();
	await expect(details).toHaveCount(0);
}

export async function exerciseComposerRunning(page: Page, imagePath: string) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const send = page.getByRole("button", { name: "发送", exact: true });
	const stop = page.getByRole("button", { name: "停止", exact: true });
	await editor.fill("验证停止输出");
	await send.click();
	const tool = page.locator('.tool-activity[data-tool="bash"]').last();
	await expect(tool).toHaveAttribute("data-state", "running");
	await expect(stop).toBeEnabled();
	await expect(send).toHaveCount(0);
	await page.getByLabel("上传附件", { exact: true }).setInputFiles(imagePath);
	await expect(send).toBeEnabled();
	await expect(stop).toHaveCount(0);
	await page.getByRole("button", { name: "移除附件 1", exact: true }).click();
	await expect(stop).toBeEnabled();
	await editor.fill("排队验证");
	await expect(stop).toHaveCount(0);
	await expect(send).toBeEnabled();
	await expect(send).toHaveAttribute("data-variant", "default");
	await send.click();
	await expect(editor).toHaveValue("");
	await expect(page.locator(".queue")).toContainText("排队验证");
	await expect(stop).toBeEnabled();
	await page.getByRole("button", { name: "清空队列", exact: true }).click();
	await expect(page.locator(".queue")).toHaveCount(0);
	await stop.click();
	await expect(stop).toHaveCount(0);
	await expect(send).toBeDisabled();
	await expect(tool).not.toHaveAttribute("data-state", "running");
	await expect(page.getByRole("button", { name: /^上下文占用 \d+\.\d+%$/ })).toBeVisible();
	await exerciseContextUsage(page);
}

export async function expectComposerLayout(page: Page) {
	const bottom = page.locator(".composer-bottom");
	const actions = page.locator(".composer-actions");
	const controls = page.locator(".composer-controls");
	for (const element of [bottom, actions, controls]) {
		expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
	}
	const boxes = await Promise.all([actions, controls, bottom].map((element) => element.boundingBox()));
	const [left, right, container] = boxes;
	if (!left || !right || !container) throw new Error("输入框控件不可见");
	expect(left.x).toBeCloseTo(container.x + await bottom.evaluate((node) => parseFloat(getComputedStyle(node).paddingLeft)), 0);
	expect(right.x + right.width).toBeCloseTo(container.x + container.width - await bottom.evaluate((node) => parseFloat(getComputedStyle(node).paddingRight)), 0);
	for (const wrapper of await page.locator('.composer [data-slot="native-select-wrapper"]').all()) {
		const select = await wrapper.locator("select").boundingBox();
		const icon = await wrapper.locator("svg").boundingBox();
		if (!select || !icon) throw new Error("模型选择控件不可见");
		expect(icon.y + icon.height / 2).toBeCloseTo(select.y + select.height / 2, 0);
	}
	await expect(page.getByRole("combobox", { name: "模型", exact: true })).toBeInViewport();
	await expect(page.getByRole("combobox", { name: "思考级别", exact: true })).toBeInViewport();
	await expect(page.getByRole("button", { name: /^上下文占用 / })).toBeInViewport();
}
