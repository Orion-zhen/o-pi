import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function exerciseModels(page: Page, settingsFile: string, screenshotName: string) {
	const modelSelect = page.locator('.composer select[aria-label="模型"]');
	const choices = () =>
		modelSelect
			.locator("option:not(:disabled)")
			.evaluateAll((options) => options.map((option) => option.getAttribute("value")));
	const savedSettings = async (): Promise<unknown> => JSON.parse(await readFile(settingsFile, "utf8"));
	const initial = ["gui-test/second", "gui-test/test"];
	await expect.poll(choices).toEqual(initial);
	await expect(modelSelect).toHaveValue("gui-test/test");
	const panel = page.getByRole("dialog", { name: "模型", exact: true });
	const open = async () => {
		if ((page.viewportSize()?.width ?? 1200) < 768)
			await page.getByRole("button", { name: "菜单", exact: true }).click();
		await page.getByRole("button", { name: "模型", exact: true }).click();
		await panel.getByRole("textbox", { name: "搜索模型" }).click();
	};
	const close = () => panel.getByRole("button", { name: "关闭面板" }).click();
	const newSession = async () => {
		if ((page.viewportSize()?.width ?? 1200) < 768)
			await page.getByRole("button", { name: "菜单", exact: true }).click();
		await page.getByRole("button", { name: "新建会话", exact: true }).click();
	};
	const checkbox = (id: string) => panel.getByRole("checkbox", { name: `已选模型 gui-test/${id}`, exact: true });
	await open();
	await panel.getByRole("textbox", { name: "搜索模型" }).fill("third");
	await expect(panel.getByRole("checkbox")).toHaveCount(1);
	await expect(checkbox("third")).not.toBeChecked();
	await panel.getByRole("button", { name: "使用模型 gui-test/third", exact: true }).click();
	await expect(panel.getByRole("button", { name: "当前模型 gui-test/third", exact: true })).toBeVisible();
	await expect.poll(choices).toEqual([...initial, "gui-test/third"]);
	await close();
	await expect(modelSelect).toHaveValue("gui-test/third");
	await expect(modelSelect.locator("option:checked")).toHaveText("GUI Third Model");
	await expect(modelSelect.locator("option:checked")).toBeEnabled();
	expect(await savedSettings()).toMatchObject({ defaultModel: "test", enabledModels: initial });

	await open();
	await checkbox("third").click();
	await expect(checkbox("third")).toBeChecked();
	await expect.poll(choices).toEqual([...initial, "gui-test/third"]);
	await panel.getByRole("button", { name: "上移 gui-test/third", exact: true }).click();
	await expect.poll(choices).toEqual(["gui-test/second", "gui-test/third", "gui-test/test"]);
	await panel.getByRole("button", { name: "上移 gui-test/third", exact: true }).click();
	await expect.poll(choices).toEqual(["gui-test/third", ...initial]);
	await checkbox("test").click();
	await expect(checkbox("test")).not.toBeChecked();
	await expect.poll(choices).toEqual(["gui-test/third", "gui-test/second"]);
	expect(await savedSettings()).toMatchObject({ enabledModels: initial });
	await close();
	await open();
	await expect(checkbox("third")).toBeChecked();
	await expect(checkbox("test")).not.toBeChecked();
	await panel.getByRole("button", { name: "保存模型", exact: true }).click();
	await expect(panel.getByText("已保存模型。", { exact: true })).toBeVisible();
	expect(await savedSettings()).toMatchObject({
		enabledModels: ["gui-test/third", "gui-test/second"],
		defaultModel: "test",
	});
	await page.screenshot({
		animations: "disabled",
		path: path.join(process.cwd(), "dist", `gui-models-${screenshotName}.png`),
	});
	await close();
	await modelSelect.selectOption("gui-test/second");
	await expect(modelSelect).toHaveValue("gui-test/second");
	expect(await savedSettings()).toMatchObject({ defaultModel: "test" });
	await newSession();
	await expect(modelSelect).toHaveValue("gui-test/test");
	await expect(modelSelect.locator("option:checked")).toHaveText("GUI Test Model");
	await expect.poll(choices).toEqual(["gui-test/third", "gui-test/second", "gui-test/test"]);
	expect(await savedSettings()).toMatchObject({
		defaultProvider: "gui-test",
		defaultModel: "test",
		enabledModels: ["gui-test/third", "gui-test/second"],
	});
	await modelSelect.selectOption("gui-test/second");
	await expect(modelSelect).toHaveValue("gui-test/second");
	await expect.poll(choices).toEqual(["gui-test/third", "gui-test/second"]);

	await open();
	await panel.getByRole("button", { name: "清空已选模型", exact: true }).click();
	await expect.poll(choices).toEqual(["gui-test/second"]);
	await panel.getByRole("button", { name: "保存模型", exact: true }).click();
	await expect(panel.getByText("已保存模型。", { exact: true })).toBeVisible();
	await close();
	await expect(modelSelect).toBeEnabled();
	await expect(modelSelect).toHaveValue("gui-test/second");
	await expect(modelSelect.locator("option:checked")).toHaveText("GUI Second Model");
	await newSession();
	await expect(modelSelect).toHaveValue("gui-test/test");
	await expect.poll(choices).toEqual(["gui-test/test"]);
	expect(await savedSettings()).toMatchObject({ defaultModel: "test", enabledModels: [] });
	await open();
	await checkbox("second").click();
	await expect(checkbox("second")).toBeChecked();
	await checkbox("test").click();
	await expect(checkbox("test")).toBeChecked();
	await expect.poll(choices).toEqual(initial);
	await expect(panel.getByRole("button", { name: "当前模型 gui-test/test", exact: true })).toBeVisible();
	await panel.getByRole("button", { name: "保存模型", exact: true }).click();
	await expect(panel.getByText("已保存模型。", { exact: true })).toBeVisible();
	await close();
	await expect(modelSelect).toHaveValue("gui-test/test");
}
