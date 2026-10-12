import { test, expect } from "@playwright/test";
import type { GuiModel } from "../../src/gui/contract.ts";
import { liveSnapshot, replayTranscript } from "./transcript-live-fixture.ts";

function emptySnapshot() {
	const model: GuiModel = { provider: "test", id: "test", name: "Test", contextWindow: 128000 };
	return { ...liveSnapshot(), entries: [], contextEntryIds: [], leafId: null, streamingMessage: null,
		model, models: [model], running: false, streaming: false, canChangeSession: true };
}

test("打开设置时资源加载失败只卸载弹窗，保留草稿且不发送消息", async ({ page }) => {
	const actions: string[] = [];
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === "/api/action") actions.push(request.postDataJSON().value.action);
	});
	const channel = await replayTranscript(page, emptySnapshot());
	try {
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("设置失败也不能丢的草稿");
		await page.route("**/settings-panel-*.js", (route) => route.abort("failed"));
		if ((page.viewportSize()?.width ?? 1200) < 768) await page.getByRole("button", { name: "菜单", exact: true }).click();
		await page.getByRole("button", { name: "设置", exact: true }).click();
		const diagnostic = page.getByRole("region", { name: "界面异常诊断" });
		await expect(diagnostic).toContainText("设置面板");
		await expect(diagnostic).not.toHaveAttribute("data-fatal");
		await expect(page.locator(".modal-layer")).toHaveCount(0);
		await expect(editor).toHaveValue("设置失败也不能丢的草稿");
		await editor.fill("仍可编辑草稿");
		await expect(diagnostic.locator("pre")).toBeHidden();
		await diagnostic.locator("summary").click();
		await expect(diagnostic.locator("pre")).toBeVisible();
		await expect(diagnostic.locator("pre")).toContainText("settings-panel-");
		expect(await page.locator("body").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		expect(actions).not.toContain("prompt");
		expect(actions).not.toContain("dialog");
	} finally { channel.close(); }
});

test("普通操作错误保留摘要，长文本可展开、折叠和关闭", async ({ page }) => {
	const channel = await replayTranscript(page, emptySnapshot());
	try {
		await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
		channel.accept({ type: "error", message: `保存失败\n${"错误明细 ".repeat(200)}` });
		const banner = page.locator(".error-banner");
		await expect(banner.locator("p")).toHaveText("保存失败");
		await expect(banner.locator("pre")).toBeHidden();
		await banner.locator("summary").click();
		await expect(banner.locator("pre")).toBeVisible();
		expect(await page.locator("body").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		await banner.locator("summary").click();
		await expect(banner.locator("pre")).toBeHidden();
		await banner.getByRole("button", { name: "关闭错误提示" }).click();
		await expect(banner).toHaveCount(0);
		await expect(page.locator(".app")).toBeVisible();
	} finally { channel.close(); }
});
