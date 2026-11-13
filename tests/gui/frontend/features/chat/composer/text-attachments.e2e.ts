import { createCanvas } from "@napi-rs/canvas";
import { test, expect } from "../../../../helpers/fixture.ts";

test("上传和拖入附件后可预览原文、切换折行、复制和移除，正文保持不变", async ({ gui: { page } }) => {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const draft = "检查 @input.txt";
	const content = ["# 附件说明", "", "```typescript", 'const message = "你好";', "```", "@missing.txt", "<script>原文</script>", `长行：${"attachment-preview/".repeat(24)}`, ""].join("\n");
	await editor.fill(draft);
	const chooser = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "附件", exact: true }).click();
	await (await chooser).setFiles([
		{ name: "README.md", mimeType: "text/markdown", buffer: Buffer.from(content) },
		{ name: "photo.png", mimeType: "image/png", buffer: createCanvas(120, 96).toBuffer("image/png") },
	]);
	const preview = page.getByRole("button", { name: "预览附件 README.md", exact: true });
	await expect(preview).toBeVisible();
	await expect(editor).toHaveValue(draft);
	await preview.click();
	const dialog = page.getByRole("dialog", { name: "README.md", exact: true });
	const source = dialog.getByRole("region", { name: "附件原文", exact: true });
	await expect(dialog.locator("pre")).toHaveText(content);
	await expect(dialog.locator("script, h1, mjx-container")).toHaveCount(0);
	await expect(dialog.locator(".token").first()).toBeVisible();
	const wrap = dialog.getByRole("button", { name: "自动折行", exact: true });
	await expect(wrap).toHaveAttribute("aria-pressed", "true");
	await expect.poll(() => source.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
	await wrap.click();
	await expect(wrap).toHaveAttribute("aria-pressed", "false");
	await expect.poll(() => source.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(100);
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await dialog.getByRole("button", { name: "复制附件原文", exact: true }).click();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(content);
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(preview).toBeFocused();
	await editor.evaluate((element) => {
		const data = new DataTransfer();
		data.items.add(new File(["补充说明\n"], "notes.txt", { type: "text/plain" }));
		element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
	});
	const dropped = page.getByRole("button", { name: "预览附件 notes.txt", exact: true });
	await dropped.click();
	const notes = page.getByRole("dialog", { name: "notes.txt", exact: true });
	await expect(notes.locator("pre")).toHaveText("补充说明\n");
	await notes.getByRole("button", { name: "关闭面板", exact: true }).click();
	await expect(notes).toHaveCount(0);
	await expect(dropped).toBeFocused();
	await page.getByRole("button", { name: "移除附件 README.md", exact: true }).click();
	await page.getByRole("button", { name: "移除附件 notes.txt", exact: true }).click();
	await expect(page.getByRole("button", { name: /^预览附件 / })).toHaveCount(0);
	await expect(page.getByRole("img", { name: "待发送图片", exact: true })).toHaveCount(1);
	await page.getByRole("button", { name: "移除附件 1", exact: true }).click();
	await expect(page.locator(".attachment-preview")).toHaveCount(0);
	await expect(editor).toHaveValue(draft);
});
