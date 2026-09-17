import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

export async function exerciseModels(page: Page, settingsFile: string) {
	const saved = async (): Promise<unknown> => JSON.parse(await readFile(settingsFile, "utf8"));
	const select = page.getByRole("combobox", { name: "模型", exact: true });
	await select.click();
	await page.getByRole("option", { name: "管理模型", exact: true }).click();
	const panel = page.getByRole("dialog", { name: "模型", exact: true });
	await panel.getByRole("button", { name: "使用模型 gui-test/third", exact: true }).click();
	await panel.getByRole("checkbox", { name: "已选模型 gui-test/third", exact: true }).click();
	await panel.getByRole("button", { name: "上移 gui-test/third", exact: true }).click();
	expect(await saved()).toMatchObject({ defaultModel: "test", enabledModels: ["gui-test/second", "gui-test/test"] });
	await panel.getByRole("button", { name: "保存模型", exact: true }).click();
	await expect.poll(saved).toMatchObject({ defaultModel: "test", enabledModels: ["gui-test/second", "gui-test/third", "gui-test/test"] });
	await panel.getByRole("button", { name: "关闭面板", exact: true }).click();
	await select.click();
	await page.getByRole("option", { name: "second", exact: true }).click();
	await expect(select).toHaveText("second");
	await page.reload();
	await expect(select).toHaveText("second");
	await select.click();
	await expect(page.getByRole("option")).toHaveText(["second", "third", "test", "管理模型"]);
}
