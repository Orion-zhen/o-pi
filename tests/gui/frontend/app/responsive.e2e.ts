import { test, expect } from "@playwright/test";
import { replayTranscript } from "../../helpers/transcript-live-fixture.ts";
import { guiSnapshot } from "../../helpers/snapshot-fixture.ts";

for (const scale of ["root", "ui"] as const) test(`会话菜单在窄屏和短窗口下适应 ${scale} 大字号`, async ({ page }) => {
	const channel = await replayTranscript(page, guiSnapshot());
	try {
		for (const viewport of [{ width: 320, height: 480 }, { width: 1200, height: 300 }]) {
			await page.setViewportSize(viewport);
			await page.getByRole("button", { name: "会话操作", exact: true }).click();
			await page.evaluate((scale) => {
				if (scale === "root") document.documentElement.style.fontSize = "200%";
				else document.documentElement.style.setProperty("--text-ui", "1.75rem");
			}, scale);
			const menu = page.getByRole("menu");
			await expect.poll(() => menu.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
					&& element.scrollWidth <= element.clientWidth;
			})).toBe(true);
			await menu.getByRole("menuitem", { name: "导出 HTML", exact: true }).scrollIntoViewIfNeeded();
			await menu.getByRole("menuitem", { name: "导出 HTML", exact: true }).click({ trial: true });
			await page.keyboard.press("Escape");
			await expect(menu).toHaveCount(0);
			await page.evaluate(() => {
				document.documentElement.style.fontSize = "";
				document.documentElement.style.removeProperty("--text-ui");
			});
		}
	} finally { channel.close(); }
});

test("搜索输入与清空按钮在窄容器中各占空间，清空后恢复输入焦点", async ({ page }) => {
	const snapshot = guiSnapshot();
	snapshot.history = ["长输入历史".repeat(40), "其他记录"];
	const channel = await replayTranscript(page, snapshot);
	try {
		await page.getByRole("button", { name: "输入历史", exact: true }).click();
		const input = page.getByRole("textbox", { name: "搜索输入历史", exact: true });
		await input.fill("长输入历史");
		await expect(page.getByRole("menuitem")).toHaveCount(1);
		await input.evaluate((element) => {
			const container = element.parentElement;
			if (!container) throw new Error("缺少搜索容器");
			container.style.maxInlineSize = "200px";
			document.documentElement.style.setProperty("--text-ui", "1.75rem");
		});
		const clear = page.getByRole("button", { name: "清空输入", exact: true });
		await expect.poll(() => input.evaluate((element) => {
			const container = element.parentElement;
			const button = container?.querySelector("button");
			if (!container || !button) throw new Error("缺少清空按钮");
			return element.getBoundingClientRect().right <= button.getBoundingClientRect().left
				&& container.scrollWidth <= container.clientWidth;
		})).toBe(true);
		await clear.click();
		await expect(input).toHaveValue("");
		await expect(input).toBeFocused();
		await expect(clear).toHaveCount(0);
		await expect(page.getByRole("menuitem")).toHaveCount(2);
		await expect(page.getByRole("menuitem", { name: "其他记录", exact: true })).toBeVisible();
	} finally { channel.close(); }
});

test("输入对话框在大字号和短窗口下保留自然按钮宽度及可达操作", async ({ page }) => {
	const channel = await replayTranscript(page, guiSnapshot());
	try {
		await page.setViewportSize({ width: 390, height: 300 });
		channel.accept({ type: "dialogs", value: [{ id: "layout-input", kind: "input", title: "需要确认的长标题".repeat(8), message: "输入备注", options: [], initial: "", deadline: null }] });
		const dialog = page.getByRole("dialog");
		const input = dialog.getByRole("textbox", { name: "输入内容", exact: true });
		await input.fill("布局验证");
		await page.evaluate(() => document.documentElement.style.setProperty("--text-ui", "1.75rem"));
		const submit = dialog.getByRole("button", { name: "提交", exact: true });
		await submit.scrollIntoViewIfNeeded();
		await expect.poll(() => submit.evaluate((element) => {
			const text = document.createRange();
			text.selectNodeContents(element);
			const style = getComputedStyle(element);
			return element.getBoundingClientRect().width + 1 >= text.getBoundingClientRect().width
				+ parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
				+ parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
		})).toBe(true);
		expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		await dialog.getByRole("button", { name: "取消", exact: true }).click({ trial: true });
		const sent = page.waitForRequest((request) => request.url().endsWith("/api/action") && request.postData()?.includes('"action":"dialog"') === true);
		await submit.click();
		expect((await sent).postData()).toContain('"value":"布局验证"');
	} finally { channel.close(); }
});
