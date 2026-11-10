import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "../../../helpers/workspace.ts";
import { storeSession } from "../../../helpers/session-fixture.ts";
import { startWebProcess } from "../../../../web/web-process.ts";

test("进入失效工作区，重命名并连续复制到已有工作区和其他目录，不自动切换", async ({ page, workspace: { home, cwd, agentDir, env } }, info) => {
	const missing = path.join(home, "missing-workspace");
	const destination = path.join(home, "destination");
	const another = path.join(home, "another");
	await storeSession({ cwd: missing, agentDir, provider: "gui-test", name: "待恢复一", text: "第一个历史问题" });
	await storeSession({ cwd: missing, agentDir, provider: "gui-test", name: "待恢复二", text: "第二个历史问题" });
	await storeSession({ cwd: destination, agentDir, provider: "gui-test", name: "目标已有历史" });
	await mkdir(another);
	await rm(missing, { recursive: true });
	const backend = startWebProcess(cwd, env);
	try {
		await page.goto(await backend.ready());
		const phone = info.project.name === "phone";
		const navigation = page.locator(phone ? ".mobile-sidebar" : ".sidebar");
		const sidebar = async () => {
			if (phone && !await page.locator('.mobile-sidebar[data-state="open"]').count())
				await page.getByRole("button", { name: "菜单", exact: true }).click();
		};
		const switchWorkspace = async (directory: string) => {
			await sidebar();
			await navigation.getByRole("combobox", { name: "工作区", exact: true }).click();
			const option = page.getByRole("option", { name: directory, exact: true });
			await option.click();
			await expect(page.getByRole("listbox", { name: "工作区列表", exact: true })).toHaveCount(0);
			if (phone) await expect(page.locator('.mobile-sidebar[data-state="open"]')).toHaveCount(0);
		};
		const openSession = async (name: string, text: string) => {
			await sidebar();
			await navigation.getByRole("button", { name, exact: true }).click();
			await expect(page.locator(".message.user")).toContainText(text);
		};
		const restore = async () => {
			await page.getByRole("button", { name: "会话操作", exact: true }).click();
			await page.getByRole("menuitem", { name: "复制到别处", exact: true }).click();
			await expect(page.getByRole("textbox", { name: "筛选工作区", exact: true })).toBeFocused();
			await expect(page.getByRole("option", { name: missing, exact: true })).toBeDisabled();
		};
		await switchWorkspace(missing);
		await sidebar();
		if (phone) await navigation.getByRole("button", { name: "文件", exact: true }).click();
		const files = navigation.getByRole("region", { name: "项目文件", exact: true });
		await expect(files.getByRole("status")).toHaveText("工作目录不可用");
		await expect(files.getByRole("button", { name: "刷新文件", exact: true })).toBeDisabled();
		if (phone) await navigation.getByRole("button", { name: "会话", exact: true }).click();
		await openSession("待恢复一", "第一个历史问题");
		await page.locator(".session-heading button").click();
		const name = page.getByRole("textbox", { name: "会话名称", exact: true });
		await name.fill("改名后恢复");
		await name.press("Enter");
		await expect(page.locator(".session-heading .session-title-target")).toHaveText("改名后恢复");
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("不能发送但保留草稿");
		await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
		await expect(page.locator("button.tool-count")).toBeEnabled();
		await editor.press("ControlOrMeta+Enter");
		await expect(editor).toHaveValue("不能发送但保留草稿");
		await expect(page.locator(".message.user")).toHaveCount(1);
		await restore();
		await page.getByRole("textbox", { name: "筛选工作区", exact: true }).fill("destination");
		await page.getByRole("option", { name: destination, exact: true }).click();
		await expect(page.getByText(`已复制到 ${destination}`, { exact: true })).toBeVisible();
		await expect(page.locator(".session-heading .session-title-target")).toHaveText("改名后恢复");
		await expect(editor).toHaveValue("不能发送但保留草稿");
		await openSession("待恢复二", "第二个历史问题");
		await restore();
		await page.getByRole("button", { name: "选择目录", exact: true }).click();
		const browser = page.getByRole("dialog", { name: "选择工作目录", exact: true });
		await expect(browser.getByRole("button", { name: "前往", exact: true })).toBeEnabled();
		await browser.getByRole("textbox", { name: "工作目录", exact: true }).fill(another);
		await browser.getByRole("button", { name: "前往", exact: true }).click();
		await expect(browser.getByRole("textbox", { name: "工作目录", exact: true })).toHaveValue(another);
		await browser.getByRole("button", { name: "选择此目录", exact: true }).click();
		await expect(browser).toHaveCount(0);
		await expect(page.getByText(`已复制到 ${another}`, { exact: true })).toBeVisible();
		await expect(page.locator(".session-heading .session-title-target")).toHaveText("待恢复二");
		await switchWorkspace(destination);
		await sidebar();
		if (phone) await navigation.getByRole("button", { name: "文件", exact: true }).click();
		await expect(files.getByText("工作目录不可用", { exact: true })).toHaveCount(0);
		await expect(files.getByRole("button", { name: "刷新文件", exact: true })).toBeEnabled();
		if (phone) await navigation.getByRole("button", { name: "会话", exact: true }).click();
		await openSession("改名后恢复", "第一个历史问题");
		await editor.fill("恢复后可以发送");
		await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
		await page.getByRole("button", { name: "会话操作", exact: true }).click();
		await expect(page.getByRole("menuitem", { name: "复制到别处", exact: true })).toHaveCount(0);
		await page.keyboard.press("Escape");
		await switchWorkspace(another);
		await openSession("待恢复二", "第二个历史问题");
	} finally {
		await page.context().close();
		await backend.close();
	}
});
