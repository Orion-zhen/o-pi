import { expect, type Page } from "@playwright/test";
import { exerciseSuggestionKeyboard } from "./suggestion-keyboard-steps.ts";

export async function exerciseSuggestions(page: Page) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const suggestions = page.getByRole("list", { name: "输入建议", exact: true });
	const rows = suggestions.getByRole("listitem");
	await editor.fill("/");
	await expect.poll(() => rows.count()).toBeGreaterThan(10);
	const layout = await rows.evaluateAll((nodes) => nodes.map((node) => {
		const row = node.getBoundingClientRect();
		const label = node.querySelector(".suggestion-label")?.getBoundingClientRect();
		const description = node.querySelector(".suggestion-description")?.getBoundingClientRect();
		return { x: row.x, y: row.y, width: row.width, bottom: row.bottom, labelY: label?.y, descriptionY: description?.y, descriptionX: description?.x };
	}));
	const [first, ...remaining] = layout;
	if (!first) throw new Error("命令建议不可见");
	let previousBottom = first.bottom;
	for (const row of remaining) {
		expect(row.x).toBeCloseTo(first.x);
		expect(row.width).toBeCloseTo(first.width);
		expect(row.labelY).toBe(row.descriptionY);
		expect(row.descriptionX).toBe(first.descriptionX);
		expect(row.y).toBeGreaterThanOrEqual(previousBottom);
		previousBottom = row.bottom;
	}
	expect(await suggestions.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
	expect(await suggestions.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
	await expect(editor).toBeInViewport();
	const last = suggestions.getByRole("button").last();
	const lastCommand = await last.locator(".suggestion-label").innerText();
	await last.click();
	await expect(editor).toHaveValue(`${lastCommand} `);
	await expect(editor).toBeFocused();
	await editor.fill("/gui-n");
	await expect(rows).toHaveCount(1);
	const command = suggestions.getByRole("button", { name: "/gui-note Record a local note", exact: true });
	await expect(command).toBeVisible();
	await command.focus();
	await page.keyboard.press("Enter");
	await expect(editor).toHaveValue("/gui-note ");
	await expect(editor).toBeFocused();
	await expect(rows).toHaveCount(2);
	await suggestions.getByRole("button", { name: "todo", exact: true }).click();
	await expect(editor).toHaveValue("/gui-note todo");
	await expect(editor).toBeFocused();
	await editor.fill("@inp");
	await editor.press("Tab");
	await suggestions.getByRole("button", { name: "input.ts", exact: true }).click();
	await expect(editor).toHaveValue('@"input.ts" ');
	await expect(editor).toBeFocused();
	await expect(rows).toHaveCount(0);
	await editor.fill("/no-such-command");
	await expect(rows).toHaveCount(0);
	await exerciseArgumentSuggestions(page);
	await exerciseSuggestionKeyboard(page);
	await editor.fill("");
}

async function exerciseArgumentSuggestions(page: Page) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const suggestions = page.getByRole("list", { name: "输入建议", exact: true });
	for (const text of ["/lsp", "/lsp "]) {
		await editor.fill(text);
		await expect(suggestions.locator(".suggestion-label")).toHaveText(["status", "reload", "diagnostics"]);
		await expect(suggestions.locator(".suggestion-description")).toHaveText([
			"查看 LSP 状态", "重载 LSP 服务", "查看诊断，可追加文件路径",
		]);
		expect(await suggestions.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
		await suggestions.getByRole("button", { name: "diagnostics 查看诊断，可追加文件路径", exact: true }).click();
		await expect(editor).toHaveValue("/lsp diagnostics");
		await expect(editor).toBeFocused();
	}
	await editor.fill("/lsp\tre");
	await expect(suggestions.locator(".suggestion-label")).toHaveText(["reload"]);
	await suggestions.getByRole("button", { name: "reload 重载 LSP 服务", exact: true }).click();
	await expect(editor).toHaveValue("/lsp reload");
	await editor.fill("/lsp diagnostics src/");
	await expect(suggestions.getByRole("listitem")).toHaveCount(0);
	await editor.fill("/usage");
	await suggestions.getByRole("button", { name: "--refresh 跳过缓存，刷新套餐用量", exact: true }).click();
	await expect(editor).toHaveValue("/usage --refresh");
	await editor.fill("/export j");
	await suggestions.getByRole("button", { name: "jsonl 导出为会话数据", exact: true }).click();
	await expect(editor).toHaveValue("/export jsonl");
	await editor.fill("/thinking");
	await suggestions.getByRole("button", { name: "off", exact: true }).click();
	await expect(editor).toHaveValue("/thinking off");
	await expect(editor).toBeFocused();
}

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
	await expect(page.getByRole("combobox", { name: "模型", exact: true })).toBeDisabled();
	await expect(page.getByRole("combobox", { name: "思考级别", exact: true })).toBeDisabled();
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
	for (const trigger of await page.locator('.composer [data-slot="select-trigger"]').all()) {
		const select = await trigger.boundingBox();
		const icon = await trigger.locator('[data-slot="select-icon"]').boundingBox();
		if (!select || !icon) throw new Error("模型选择控件不可见");
		expect(icon.y + icon.height / 2).toBeCloseTo(select.y + select.height / 2, 0);
	}
	await expect(page.getByRole("combobox", { name: "模型", exact: true })).toBeInViewport();
	await expect(page.getByRole("combobox", { name: "思考级别", exact: true })).toBeInViewport();
	await expect(page.getByRole("button", { name: /^上下文占用 / })).toBeInViewport();
}
