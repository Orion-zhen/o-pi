import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

export async function exerciseModels(page: Page, settingsFile: string) {
	const modelSelect = page.getByRole("combobox", { name: "模型", exact: true });
	const names = { test: "GUI Test Model", second: "GUI Second Model", third: "GUI Third Model" };
	const expectChoices = async (ids: (keyof typeof names)[], current: keyof typeof names) => {
		await expect(modelSelect).toHaveText(names[current]);
		await modelSelect.click();
		await expect(page.getByRole("option")).toHaveText([...ids.map((id) => names[id]), "管理模型"]);
		await expect(page.getByRole("option", { name: names[current], exact: true })).toHaveAttribute("aria-selected", "true");
		await page.keyboard.press("Escape");
		await expect(modelSelect).toBeFocused();
	};
	const choose = async (id: keyof typeof names) => {
		await modelSelect.click();
		await page.getByRole("option", { name: names[id], exact: true }).click();
		await expect(modelSelect).toHaveText(names[id]);
	};
	const savedSettings = async (): Promise<unknown> => JSON.parse(await readFile(settingsFile, "utf8"));
	const initial = ["gui-test/second", "gui-test/test"];
	await expectChoices(["second", "test"], "test");
	const panel = page.getByRole("dialog", { name: "模型", exact: true });
	const open = async () => {
		if ((page.viewportSize()?.width ?? 1200) < 768)
			await page.getByRole("button", { name: "菜单", exact: true }).click();
		await page.getByRole("button", { name: "模型", exact: true }).click();
		await panel.getByRole("textbox", { name: "搜索模型" }).click();
	};
	const close = async () => {
		await panel.getByRole("button", { name: "关闭面板" }).click();
		await expect(panel).toHaveCount(0);
		await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
	};
	const newSession = async () => {
		if ((page.viewportSize()?.width ?? 1200) < 768)
			await page.getByRole("button", { name: "菜单", exact: true }).click();
		await page.getByRole("button", { name: "新建会话", exact: true }).click();
	};
	const checkbox = (id: string) => panel.getByRole("checkbox", { name: `已选模型 gui-test/${id}`, exact: true });
	const selectedNames = panel.getByRole("region", { name: "已选模型", exact: true }).locator(".model-name strong");
	await open();
	const thinking = panel.getByRole("combobox", { name: "思考级别", exact: true });
	await thinking.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("listbox")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(panel).toBeVisible();
	await expect(thinking).toBeFocused();
	await panel.getByRole("textbox", { name: "搜索模型" }).fill("third");
	await expect(panel.getByRole("checkbox")).toHaveCount(1);
	await expect(checkbox("third")).not.toBeChecked();
	await panel.getByRole("button", { name: "使用模型 gui-test/third", exact: true }).click();
	await expect(panel.getByRole("button", { name: "当前模型 gui-test/third", exact: true })).toBeVisible();
	await close();
	await expectChoices(["second", "test", "third"], "third");
	expect(await savedSettings()).toMatchObject({ defaultModel: "test", enabledModels: initial });

	await open();
	await checkbox("third").click();
	await expect(checkbox("third")).toBeChecked();
	await panel.getByRole("button", { name: "上移 gui-test/third", exact: true }).click();
	await expect(selectedNames).toHaveText([names.second, names.third, names.test]);
	await panel.getByRole("button", { name: "上移 gui-test/third", exact: true }).click();
	await expect(selectedNames).toHaveText([names.third, names.second, names.test]);
	await checkbox("test").click();
	await expect(checkbox("test")).not.toBeChecked();
	await expect(selectedNames).toHaveText([names.third, names.second]);
	expect(await savedSettings()).toMatchObject({ enabledModels: initial });
	await close();
	await expectChoices(["third", "second"], "third");
	await open();
	await expect(checkbox("third")).toBeChecked();
	await expect(checkbox("test")).not.toBeChecked();
	await panel.getByRole("button", { name: "保存模型", exact: true }).click();
	await expect.poll(savedSettings).toMatchObject({
		enabledModels: ["gui-test/third", "gui-test/second"],
		defaultModel: "test",
	});
	await close();
	await choose("second");
	expect(await savedSettings()).toMatchObject({ defaultModel: "test" });
	await newSession();
	await expectChoices(["third", "second", "test"], "test");
	expect(await savedSettings()).toMatchObject({
		defaultProvider: "gui-test",
		defaultModel: "test",
		enabledModels: ["gui-test/third", "gui-test/second"],
	});
	await choose("second");
	await expectChoices(["third", "second"], "second");

	await open();
	await panel.getByRole("button", { name: "清空已选模型", exact: true }).click();
	await expect(panel.getByRole("checkbox", { checked: true })).toHaveCount(0);
	await panel.getByRole("button", { name: "保存模型", exact: true }).click();
	await expect.poll(savedSettings).toMatchObject({ enabledModels: [] });
	await close();
	await expect(modelSelect).toBeEnabled();
	await expectChoices(["second"], "second");
	await newSession();
	await expectChoices(["test"], "test");
	expect(await savedSettings()).toMatchObject({ defaultModel: "test", enabledModels: [] });
	await open();
	await checkbox("second").click();
	await expect(checkbox("second")).toBeChecked();
	await checkbox("test").click();
	await expect(checkbox("test")).toBeChecked();
	await expect(panel.getByRole("button", { name: "当前模型 gui-test/test", exact: true })).toBeVisible();
	await panel.getByRole("button", { name: "保存模型", exact: true }).click();
	await expect.poll(savedSettings).toMatchObject({ enabledModels: initial });
	await close();
	await expectChoices(["second", "test"], "test");
}
