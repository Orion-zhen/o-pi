import { expect, type Page } from "@playwright/test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { storeSession } from "./session-fixture.ts";
import { chooseWorkspace, type prepareHistory } from "./session-steps.ts";
import { clickRowAction } from "./row-action-layout.ts";

export async function exerciseDeletion(page: Page, fixture: Awaited<ReturnType<typeof prepareHistory>>, screenshotName: string) {
	const phone = (page.viewportSize()?.width ?? 1200) < 768;
	const cwd = path.join(path.dirname(fixture.cwd), "delete-project");
	const options = { cwd, agentDir: fixture.agentDir, provider: fixture.provider };
	const first = await storeSession({ ...options, name: "待删除会话一" });
	const second = await storeSession({ ...options, name: "待删除会话二" });
	const source = path.join(cwd, "source.ts");
	await writeFile(source, "export const retained = true;\n");
	const history = page.getByRole("region", { name: "历史会话", exact: true });
	const sidebar = async () => {
		if (phone && !await page.getByRole("dialog", { name: "工作空间导航", exact: true }).count())
			await page.getByRole("button", { name: "菜单", exact: true }).click();
	};
	const removed = async (file: string) => {
		await expect.poll(async () => (await readdir(path.dirname(file))).includes(path.basename(file))).toBe(false);
	};
	await sidebar();
	await history.getByRole("button", { name: "刷新会话", exact: true }).click();
	await chooseWorkspace(page, cwd);
	await expect(history.getByRole("button", { name: /工作区 .* 的更多操作/ })).toHaveCount(0);
	const removeFirst = history.getByRole("button", { name: "删除会话 待删除会话一", exact: true });
	const confirmFirst = history.getByRole("button", { name: "确认删除会话 待删除会话一", exact: true });
	await clickRowAction(removeFirst);
	await expect(confirmFirst).toBeVisible();
	await expect(page.getByRole("dialog", { name: "删除会话", exact: true })).toHaveCount(0);
	expect(await readFile(first, "utf8")).toContain("待删除会话一");
	await page.screenshot({ animations: "disabled", path: path.join(process.cwd(), "dist", `gui-delete-${screenshotName}.png`) });
	await confirmFirst.press("Escape");
	await expect(removeFirst).toBeVisible();
	await clickRowAction(removeFirst);
	await history.getByRole("heading").click();
	await expect(confirmFirst).toHaveCount(0);
	expect(await readFile(first, "utf8")).toContain("待删除会话一");
	await clickRowAction(removeFirst);
	await confirmFirst.click();
	await removed(first);
	expect(await readFile(second, "utf8")).toContain("待删除会话二");
	await history.getByRole("button", { name: "待删除会话二", exact: true }).click();
	await expect(page.locator(".session-heading button")).toHaveText("待删除会话二");
	await sidebar();
	await clickRowAction(history.getByRole("button", { name: "删除会话 待删除会话二", exact: true }), { modifiers: ["Control"] });
	await expect(page.getByRole("dialog", { name: "删除会话", exact: true })).toHaveCount(0);
	await removed(second);
	if (phone) await page.getByRole("button", { name: "关闭菜单", exact: true }).click();
	await expect(page.locator(".session-heading button")).toHaveText("未命名会话");
	await expect(page.getByRole("heading", { name: "今天，想构建什么？", exact: true })).toBeVisible();
	await expect(page.locator(".message")).toHaveCount(0);
	expect(await readFile(source, "utf8")).toBe("export const retained = true;\n");
	await page.reload();
	await expect(page.locator(".session-heading button")).toHaveText("未命名会话");
	await sidebar();
	await page.getByRole("combobox", { name: "工作区", exact: true }).click();
	await page.getByRole("button", { name: "选择目录", exact: true }).click();
	if (!(await page.evaluate(() => Boolean(window.opi)))) {
		const browser = page.getByRole("dialog", { name: "选择工作目录", exact: true });
		await expect(browser).toBeVisible();
		await expect(browser.locator("header").getByRole("button", { name: "关闭目录选择", exact: true })).toBeVisible();
		expect(await browser.locator("header").evaluate((header) => {
			const title = header.querySelector("h2")?.getBoundingClientRect();
			const close = header.querySelector("button")?.getBoundingClientRect();
			return Boolean(title && close && close.left >= title.right && close.top < title.bottom && close.bottom > title.top);
		})).toBe(true);
		await expect(browser.getByRole("button", { name: "选择此目录", exact: true })).toBeEnabled();
		await browser.getByRole("button", { name: "上级目录", exact: true }).click();
		await expect(browser.getByRole("button", { name: "delete-project", exact: true })).toBeVisible();
		await browser.getByRole("textbox", { name: "筛选目录", exact: true }).fill("delete-project");
		await expect(browser.locator(".directory-list button")).toHaveCount(1);
		await browser.getByRole("button", { name: "delete-project", exact: true }).click();
		await expect(browser.getByRole("textbox", { name: "工作目录", exact: true })).toHaveValue(cwd);
		await browser.getByRole("textbox", { name: "工作目录", exact: true }).fill(cwd);
		await browser.getByRole("button", { name: "前往", exact: true }).click();
		await expect(browser.getByRole("button", { name: "选择此目录", exact: true })).toBeEnabled();
		await browser.getByRole("button", { name: "选择此目录", exact: true }).click();
	}
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
	await chooseWorkspace(page, fixture.cwd);
	await history.getByRole("button", { name: "当前 GUI 会话", exact: true }).click();
	await expect(page.locator(".session-heading button")).toHaveText("当前 GUI 会话");
	await expect(page.getByRole("main").getByText("GUI 验证完成：图片、代码搜索和文件写入。", { exact: true })).toBeVisible();
	expect(await readFile(source, "utf8")).toBe("export const retained = true;\n");
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
