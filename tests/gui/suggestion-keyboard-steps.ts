import { expect, type Page } from "@playwright/test";

export async function exerciseSuggestionKeyboard(page: Page) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const menu = page.getByRole("list", { name: "输入建议", exact: true });
	const buttons = menu.getByRole("button");
	await editor.fill("/");
	await editor.press("Tab");
	await expect(buttons.first()).toBeFocused();
	await page.keyboard.press("ArrowUp");
	await expect(buttons.last()).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(buttons.first()).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(editor).toBeFocused();
	await expect(editor).toHaveValue("/");

	await editor.fill("/lsp ");
	await expect(menu.locator(".suggestion-label")).toHaveText(["status", "reload", "diagnostics"]);
	for (const key of ["Tab", "ArrowDown", "Enter"]) {
		await editor.dispatchEvent("keydown", { key, isComposing: true });
		await expect(editor).toBeFocused();
		await expect(editor).toHaveValue("/lsp ");
	}
	await editor.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true });
	await expect(editor).toHaveValue("/lsp ");
	await editor.press("ArrowDown");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await expect(editor).toHaveValue("/lsp reload");
	await expect(editor).toBeFocused();
	await expect(page.locator(".message.user")).toHaveCount(0);

	await editor.fill("@i");
	await editor.press("Tab");
	await expect(buttons).toHaveCount(2);
	await expect(editor).toBeFocused();
	await editor.press("Tab");
	await expect(buttons.first()).toBeFocused();
	await page.keyboard.press("ArrowDown");
	const file = await buttons.last().innerText();
	await page.keyboard.press("Enter");
	await expect(editor).toHaveValue(`@"${file}" `);
	await expect(editor).toBeFocused();
	await expect(buttons).toHaveCount(0);

	await editor.fill("普通消息");
	await editor.press("Enter");
	await expect(editor).toHaveValue("普通消息\n");
	await editor.press("Tab");
	await expect(page.getByRole("button", { name: "附件", exact: true })).toBeFocused();
	await editor.fill("");
}
