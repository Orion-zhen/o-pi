import { test, expect } from "./fixture.ts";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { storeSession } from "./session-fixture.ts";
import { clickRowAction } from "./row-actions.ts";

let file: string;
test.beforeEach(async ({ workspace: { cwd, agentDir } }) => {
	file = await storeSession({ cwd, agentDir, provider: "gui-test", name: "历史任务" });
	await writeFile(path.join(cwd, "retained.txt"), "项目文件\n");
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
