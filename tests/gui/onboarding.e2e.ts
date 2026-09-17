import { test, expect } from "./fixture.ts";

test("未配置模型时保留草稿，认证后可选择模型", async ({ gui: { page } }) => {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	await editor.fill("保留这条草稿");
	await editor.press("ControlOrMeta+Enter");
	const auth = page.getByRole("dialog", { name: "认证", exact: true });
	await expect(auth).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(editor).toHaveValue("保留这条草稿");
	await expect(page.locator(".message.user")).toHaveCount(0);
	await page.locator(".welcome").getByRole("button", { name: "添加模型服务", exact: true }).click();
	const provider = auth.locator(".list-row").filter({ hasText: /^Anthropic/ });
	await provider.getByRole("button", { name: "API Key", exact: true }).click();
	await page.getByLabel("输入内容", { exact: true }).fill("onboarding-test-key");
	await page.getByRole("button", { name: "提交", exact: true }).click();
	await expect(provider).toHaveAttribute("data-authenticated", "true");
	await page.keyboard.press("Escape");
	await page.locator(".welcome").getByRole("button", { name: "选择模型", exact: true }).click();
	await page.getByRole("button", { name: /^使用模型 anthropic\// }).first().click();
	await page.keyboard.press("Escape");
	const model = page.getByRole("combobox", { name: "模型", exact: true });
	const selected = await model.innerText();
	await page.reload();
	await expect(model).toHaveText(selected);
});
