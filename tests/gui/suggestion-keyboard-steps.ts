import { expect, type Page } from "@playwright/test";

export async function exerciseSuggestionRefresh(page: Page) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const menu = page.getByRole("list", { name: "输入建议", exact: true });
	const now = Date.now();
	await page.clock.install({ time: now });
	await page.clock.pauseAt(now + 1000);
	try {
		await editor.fill("/lsp");
		await expect(menu.locator(".suggestion-label")).toHaveText(["/lsp"]);
		await editor.press("Tab");
		await expect(menu.getByRole("button")).toBeFocused();
		await page.clock.runFor(250);
		await expect(menu.locator(".suggestion-label")).toHaveText(["status", "reload", "diagnostics"]);
		await expect(editor).toBeFocused();
		await editor.fill("");
	} finally {
		await page.clock.resume();
	}
}

export async function exerciseSuggestionKeyboard(page: Page) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const menu = page.getByRole("list", { name: "输入建议", exact: true });
	const buttons = menu.getByRole("button");
	await editor.fill("/");
	await expect.poll(() => buttons.count()).toBeGreaterThan(10);
	await editor.press("Tab");
	await expect(buttons.first()).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(buttons.nth(1)).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(buttons.first()).toBeFocused();
	await page.keyboard.press("ArrowUp");
	await expect(buttons.last()).toBeFocused();
	await expect(buttons.last()).toBeInViewport();
	expect(await menu.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
	await page.keyboard.press("Tab");
	await expect(buttons.first()).toBeFocused();
	await expect(buttons.first()).toBeInViewport();
	expect(await buttons.first().evaluate((node) => node.matches(":focus-visible"))).toBe(true);
	await page.keyboard.press("Escape");
	await expect(editor).toBeFocused();
	await expect(editor).toHaveValue("/");
	for (const key of ["Shift+Tab", "ArrowUp"]) {
		await editor.press(key);
		await expect(buttons.last()).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(editor).toBeFocused();
	}
	await editor.press("ArrowDown");
	await expect(buttons.first()).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(buttons.nth(1)).toBeFocused();
	const command = await buttons.nth(1).locator(".suggestion-label").innerText();
	await page.keyboard.press("Enter");
	await expect(editor).toHaveValue(`${command} `);
	await expect(editor).toBeFocused();

	await editor.fill("/lsp ");
	await expect(menu.locator(".suggestion-label")).toHaveText(["status", "reload", "diagnostics"]);
	for (const key of ["Tab", "ArrowDown", "Enter"]) {
		await editor.dispatchEvent("keydown", { key, isComposing: true });
		await expect(editor).toBeFocused();
		await expect(editor).toHaveValue("/lsp ");
	}
	await editor.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true });
	await expect(editor).toHaveValue("/lsp ");
	await editor.press("ArrowUp");
	await expect(buttons.last()).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(buttons.first()).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(buttons.nth(1)).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(editor).toHaveValue("/lsp reload");
	await expect(editor).toBeFocused();
	await expect(page.getByText("LSP reloaded", { exact: true })).toHaveCount(0);

	await editor.fill("@i");
	await editor.press("Tab");
	await expect(buttons).toHaveCount(2);
	await expect(editor).toBeFocused();
	await editor.press("Tab");
	await expect(buttons.first()).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(buttons.last()).toBeFocused();
	const file = await buttons.last().innerText();
	await page.keyboard.press("Enter");
	await expect(editor).toHaveValue(`@"${file}" `);
	await expect(editor).toBeFocused();
	await expect(buttons).toHaveCount(0);

	await editor.fill("第一行\n第二行");
	await editor.press("ArrowUp");
	expect(await editor.evaluate((node: HTMLTextAreaElement) => node.selectionStart)).toBeLessThan(4);
	await editor.fill("普通消息");
	await editor.press("Enter");
	await expect(editor).toHaveValue("普通消息\n");
	await editor.press("Tab");
	await expect(page.getByRole("button", { name: "附件", exact: true })).toBeFocused();
	await editor.fill("");
}
