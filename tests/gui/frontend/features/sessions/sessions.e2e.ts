import { test, expect } from "../../../helpers/fixture.ts";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { storeSession } from "../../../helpers/session-fixture.ts";
import { clickRowAction } from "../../../helpers/row-actions.ts";

let file: string;
test.beforeEach(async ({ workspace: { cwd, agentDir } }) => {
	file = await storeSession({ cwd, agentDir, provider: "gui-test", name: "历史任务" });
	await writeFile(path.join(cwd, "retained.txt"), "项目文件\n");
});

test("反复新建复用空白页，草稿不入列表，首次发送才显示", async ({ gui: { page } }, info) => {
	const phone = info.project.name === "phone";
	const open = async () => { if (phone) await page.getByRole("button", { name: "菜单", exact: true }).click(); };
	const history = page.getByRole("region", { name: "历史会话", exact: true });
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	await expect(editor).toBeVisible();
	await editor.fill("保留草稿");
	for (let index = 0; index < 10; index++) {
		await open();
		await page.getByRole("button", { name: "新建会话", exact: true }).click();
		await expect(editor).toHaveValue("保留草稿");
	}
	await open();
	await expect(history.locator(".history-session-row")).toHaveCount(1);
	await history.getByRole("button", { name: "历史任务", exact: true }).click();
	await expect(page.locator(".message.user")).toContainText("历史问题");
	await open();
	await page.getByRole("button", { name: "新建会话", exact: true }).click();
	await expect(editor).toHaveValue("保留草稿");
	await page.locator(".session-heading button").click();
	await page.getByRole("textbox", { name: "会话名称", exact: true }).fill("首次提交");
	await page.getByRole("textbox", { name: "会话名称", exact: true }).press("Enter");
	await editor.fill("!printf first-message");
	await editor.press("ControlOrMeta+Enter");
	await open();
	await expect(history.getByRole("button", { name: "首次提交", exact: true })).toBeVisible();
	await expect(history.locator(".history-session-row")).toHaveCount(2);
});

test("正文多关键词搜索显示中文命中片段，清空恢复列表，结果可打开", async ({ gui: { page }, workspace: { cwd, agentDir } }, info) => {
	await storeSession({ cwd, agentDir, provider: "gui-test", name: "正文搜索目标", text: "𠮷😀中文内容包含不相邻的 SEARCH 关键词" });
	const phone = info.project.name === "phone";
	if (phone) await page.getByRole("button", { name: "菜单", exact: true }).click();
	const history = page.getByRole("region", { name: "历史会话", exact: true });
	await history.getByRole("button", { name: "刷新会话", exact: true }).click();
	const search = page.getByRole("textbox", { name: "搜索会话", exact: true });
	await search.fill("𠮷😀中文 search");
	const target = history.getByRole("button", { name: "正文搜索目标", exact: true });
	await expect(target).toBeVisible();
	await expect(target.locator("mark")).toHaveText(["𠮷😀中文", "SEARCH"]);
	await expect(history.getByRole("button", { name: "历史任务", exact: true })).toHaveCount(0);
	await search.fill("完全不存在的关键词");
	await expect(history).toContainText("没有匹配的会话");
	await search.fill("");
	await expect(history.getByRole("button", { name: "历史任务", exact: true })).toBeVisible();
	await search.fill("𠮷😀中文 search");
	await target.click();
	await expect(page.locator(".message.user")).toContainText("𠮷😀中文内容");
});

test("长前文的标题和正文命中在窄侧栏内保持可见", async ({ gui: { page }, workspace: { cwd, agentDir } }, info) => {
	const prefix = "很长的中文上下文𠮷😀".repeat(12);
	const title = prefix + "大小" + "标题后文".repeat(8);
	await storeSession({ cwd, agentDir, provider: "gui-test", name: title });
	await storeSession({ cwd, agentDir, provider: "gui-test", name: "正文搜索目标", text: prefix + "大小" + "正文后文".repeat(8) });
	const phone = info.project.name === "phone";
	if (phone) await page.getByRole("button", { name: "菜单", exact: true }).click();
	const history = page.getByRole("region", { name: "历史会话", exact: true });
	await history.getByRole("button", { name: "刷新会话", exact: true }).click();
	await page.getByRole("textbox", { name: "搜索会话", exact: true }).fill("大小");
	const checkHighlights = async () => {
		for (const name of [title, "正文搜索目标"]) {
			const target = history.getByRole("button", { name, exact: true });
			const mark = target.locator("mark").first();
			await expect(target).toBeVisible();
			await expect(mark).toHaveText("大小");
			await expect(mark).toBeInViewport({ ratio: 1 });
			await expect.poll(() => mark.evaluate((element) => {
				const container = element.parentElement;
				if (!container) throw new Error("缺少摘要容器");
				const ellipsis = container.scrollWidth > container.clientWidth ? parseFloat(getComputedStyle(container).fontSize) : 0;
				return container.getBoundingClientRect().right - element.getBoundingClientRect().right - ellipsis;
			})).toBeGreaterThanOrEqual(0);
		}
	};
	await checkHighlights();
	if (!phone) {
		const handle = page.getByRole("separator", { name: "调整左侧栏宽度", exact: true });
		for (const key of ["ArrowRight", "ArrowLeft"]) {
			for (let index = 0; index < 8; index++) await handle.press(key);
			await checkHighlights();
		}
	}
});

test("恢复、重命名和确认删除会话，不删除项目文件", async ({ gui: { page }, workspace: { cwd } }, info) => {
	const phone = info.project.name === "phone";
	const open = async () => { if (phone) await page.getByRole("button", { name: "菜单", exact: true }).click(); };
	const history = page.getByRole("region", { name: "历史会话", exact: true });
	await open();
	const search = page.getByRole("textbox", { name: "搜索会话", exact: true });
	await search.fill("历史任务");
	await history.getByRole("button", { name: "历史任务", exact: true }).click();
	await expect(page.locator(".message.user")).toContainText("历史问题");
	await page.locator(".session-heading button").click();
	const name = page.getByRole("textbox", { name: "会话名称", exact: true });
	await name.fill("已恢复任务");
	await name.press("Enter");
	await expect(async () => expect(await readFile(file, "utf8")).toContain("已恢复任务")).toPass();
	await open();
	await search.fill("");
	const remove = history.getByRole("button", { name: "删除会话 已恢复任务", exact: true });
	await clickRowAction(remove);
	const confirm = history.getByRole("button", { name: "确认删除会话 已恢复任务", exact: true });
	await confirm.press("Escape");
	expect(await readFile(file, "utf8")).toContain("已恢复任务");
	await clickRowAction(remove);
	await confirm.click();
	await expect(remove).toHaveCount(0);
	await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readFile(path.join(cwd, "retained.txt"), "utf8")).toBe("项目文件\n");
	await page.reload();
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
	await expect(page.locator(".message.user")).toHaveCount(0);
});
