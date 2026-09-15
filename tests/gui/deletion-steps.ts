import { expect, type Page } from "@playwright/test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { storeSession } from "./session-fixture.ts";
import type { prepareHistory } from "./session-steps.ts";

export async function exerciseDeletion(
	page: Page,
	fixture: Awaited<ReturnType<typeof prepareHistory>>,
	screenshotName: string,
) {
	const phone = (page.viewportSize()?.width ?? 1200) < 768;
	const cwd = path.join(path.dirname(fixture.cwd), "delete-project");
	const options = { cwd, agentDir: fixture.agentDir, provider: fixture.provider };
	const first = await storeSession({ ...options, name: "待删除会话一" });
	const second = await storeSession({ ...options, name: "待删除会话二" });
	const source = path.join(cwd, "source.ts");
	await writeFile(source, "export const retained = true;\n");
	const history = page.getByRole("region", { name: "历史会话", exact: true });
	const sidebar = async () => {
		if (phone && (await page.getByRole("dialog", { name: "工作空间导航", exact: true }).count()) === 0)
			await page.getByRole("button", { name: "菜单", exact: true }).click();
	};
	const workspace = async (directory: string) => {
		await sidebar();
		const toggle = page.getByRole("button", { name: `工作区 ${directory}`, exact: true });
		if ((await toggle.count()) === 0) {
			const others = history.getByRole("button", { name: /^其他工作区/ });
			if ((await others.getAttribute("aria-expanded")) === "false") await others.click();
		}
		const group = history.locator(".workspace-sessions").filter({ has: toggle });
		await expect(group).toBeVisible();
		if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
		return group;
	};
	const deleteMenu = async (label: string, item: "删除会话" | "删除工作区") => {
		const group = await workspace(cwd);
		const menu = group.getByRole("button", { name: label, exact: true });
		await menu.hover();
		await menu.click();
		await page.getByRole("menuitem", { name: item, exact: true }).click();
		const dialog = page.getByRole("dialog", { name: item, exact: true });
		await expect(dialog).toBeVisible();
		return dialog;
	};
	const removed = async (file: string) => {
		await expect.poll(async () => (await readdir(path.dirname(file))).includes(path.basename(file))).toBe(false);
	};
	await sidebar();
	await history.getByRole("button", { name: "刷新会话", exact: true }).click();
	let dialog = await deleteMenu("会话 待删除会话一 的更多操作", "删除会话");
	await expect(dialog).toContainText("1 个共享历史会话");
	await expect(dialog).toContainText("不会删除项目目录、代码或配置");
	await page.screenshot({
		animations: "disabled",
		path: path.join(process.cwd(), "dist", `gui-delete-${screenshotName}.png`),
	});
	await dialog.getByRole("button", { name: "取消 / 拒绝", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	expect(await readFile(first, "utf8")).toContain("待删除会话一");
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
	dialog = await deleteMenu("会话 待删除会话一 的更多操作", "删除会话");
	await dialog.getByRole("button", { name: "确认", exact: true }).click();
	await removed(first);
	expect(await readFile(second, "utf8")).toContain("待删除会话二");

	await (await workspace(cwd)).getByRole("button", { name: "待删除会话二", exact: true }).click();
	await expect(page.locator(".session-heading button")).toHaveText("待删除会话二");
	dialog = await deleteMenu("会话 待删除会话二 的更多操作", "删除会话");
	await dialog.getByRole("button", { name: "确认", exact: true }).click();
	await removed(second);
	await expect(page.locator(".session-heading button")).toHaveText("未命名会话");
	await expect(page.getByRole("heading", { name: "今天，想构建什么？", exact: true })).toBeVisible();
	await expect(page.locator(".message")).toHaveCount(0);
	const third = await storeSession({ ...options, name: "批量删除一" });
	const fourth = await storeSession({ ...options, name: "批量删除二" });
	await sidebar();
	await history.getByRole("button", { name: "刷新会话", exact: true }).click();
	dialog = await deleteMenu(`工作区 ${cwd} 的更多操作`, "删除工作区");
	await expect(dialog).toContainText("2 个共享历史会话");
	await dialog.getByRole("button", { name: "确认", exact: true }).click();
	await removed(third);
	await removed(fourth);
	await expect(page.getByRole("heading", { name: "选择工作区", exact: true })).toBeVisible();
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveCount(0);
	expect(await readFile(source, "utf8")).toBe("export const retained = true;\n");
	await page.reload();
	await expect(page.getByRole("heading", { name: "选择工作区", exact: true })).toBeVisible();
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveCount(0);
	await page.screenshot({
		animations: "disabled",
		path: path.join(process.cwd(), "dist", `gui-workspace-picker-${screenshotName}.png`),
	});
	const picker = page.locator(".workspace-welcome");
	await picker.getByRole("textbox", { name: "工作目录", exact: true }).fill(cwd);
	await picker.getByRole("button", { name: "打开工作目录", exact: true }).click();
	await expect(page.locator(".session-heading button")).toHaveText("未命名会话");
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
	dialog = await deleteMenu(`工作区 ${cwd} 的更多操作`, "删除工作区");
	await expect(dialog).toContainText("0 个共享历史会话");
	await dialog.getByRole("button", { name: "确认", exact: true }).click();
	await expect(page.getByRole("heading", { name: "选择工作区", exact: true })).toBeVisible();
	await (await workspace(fixture.cwd)).getByRole("button", { name: "当前 GUI 会话", exact: true }).click();
	await expect(page.locator(".session-heading button")).toHaveText("当前 GUI 会话");
	await expect(page.getByText("GUI 验证完成：图片、代码搜索和文件写入。", { exact: true })).toBeVisible();
	expect(await readFile(source, "utf8")).toBe("export const retained = true;\n");
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
