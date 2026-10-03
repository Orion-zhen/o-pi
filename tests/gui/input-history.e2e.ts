import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixture.ts";

const longEntry = `${"较长的输入历史正文".repeat(20)} Hidden Needle`;
const history = ["早期 Alpha 记录", ...Array.from({ length: 30 }, (_, index) => `历史记录 ${index}`), longEntry, "最新 ALPHA 记录"];

test.beforeEach(async ({ workspace: { home, cwd } }) => {
	const directory = path.join(home, ".pi", "cache", "user-history");
	await mkdir(directory, { recursive: true });
	await writeFile(path.join(directory, "history.jsonl"), history.map((text, index) => JSON.stringify({
		timestamp: new Date(1_700_000_000_000 + index).toISOString(), cwd, session: "history-session", text,
	})).join("\n") + "\n");
});

test.describe("输入历史", () => {

	test("输入历史底部搜索、全文筛选和回填", async ({ gui: { page } }) => {
		const trigger = page.getByRole("button", { name: "输入历史", exact: true });
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("未提交的草稿");
		await trigger.click();
		const menu = page.locator(".history-menu");
		const entries = menu.getByRole("menuitem");
		const search = menu.getByRole("textbox", { name: "搜索输入历史", exact: true });
		await expect(entries).toHaveCount(history.length);
		await expect(entries.first()).toHaveText("最新 ALPHA 记录");
		await expect(search).toBeInViewport();
		await menu.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
		const top = await search.evaluate((element) => element.getBoundingClientRect().top);
		const list = menu.locator(".history-menu-list");
		expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
		await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
		await expect(search).toBeInViewport();
		expect(await search.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(top, 0);

		const width = await menu.evaluate((element) => element.getBoundingClientRect().width);
		const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
		await page.setViewportSize({ width: Math.floor(viewport.width * 0.9), height: Math.floor(viewport.height * 0.85) });
		await expect.poll(() => menu.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(width);
		await expect(search).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await search.click();
		await search.pressSequentially("aLpHa");
		await expect(search).toBeFocused();
		await expect(entries).toHaveText(["最新 ALPHA 记录", "早期 Alpha 记录"]);
		const idleBackground = await entries.first().evaluate((element) => getComputedStyle(element).backgroundColor);
		await entries.first().hover();
		await expect(entries.first()).not.toHaveCSS("background-color", idleBackground);
		await expect(search).toBeFocused();
		await entries.last().hover();
		await expect(entries.first()).toHaveCSS("background-color", idleBackground);
		await expect(entries.last()).not.toHaveCSS("background-color", idleBackground);
		await expect(search).toBeFocused();
		await page.mouse.move(0, 0);
		await expect(entries.last()).toHaveCSS("background-color", idleBackground);
		await expect(search).toBeFocused();
		await search.fill("找不到的历史");
		await expect(entries).toHaveCount(0);
		await expect(menu.getByRole("status")).toHaveText("无匹配的输入历史");
		await search.fill("");
		await search.pressSequentially("hidden needle");
		await expect(search).toHaveValue("hidden needle");
		await expect(entries).toHaveCount(1);
		await entries.first().click();
		await expect(menu).toHaveCount(0);
		await expect(editor).toHaveValue(longEntry);
		await expect(editor).toBeFocused();

		await trigger.click();
		await expect(search).toHaveValue("");
		await expect(entries).toHaveCount(history.length);
		await search.fill("Alpha");
		await search.press("Escape");
		await expect(menu).toHaveCount(0);
		await expect(editor).toHaveValue(longEntry);
		await expect(editor).toBeFocused();
		await trigger.focus();
		await trigger.press("ArrowDown");
		await expect(search).toHaveValue("");
		await expect(entries.first()).toBeFocused();
		await expect(entries.first()).not.toHaveCSS("background-color", idleBackground);
		await page.keyboard.press("Tab");
		await expect(search).toBeFocused();
		await search.pressSequentially("alpha");
		await expect(entries).toHaveCount(2);
		await search.press("Tab");
		await expect(entries.first()).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(editor).toHaveValue("最新 ALPHA 记录");
	});
});
