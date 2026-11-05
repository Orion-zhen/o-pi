import { test, expect } from "@playwright/test";
import { guiModelFixture } from "../../helpers/snapshot-fixture.ts";
import { liveSnapshot, replayTranscript } from "../../helpers/transcript-live-fixture.ts";

function emptySnapshot() {
	const model = guiModelFixture();
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
		await page.route("**/panel-*.js", (route) => route.abort("failed"));
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
		await expect(diagnostic.locator("pre")).toContainText("panel-");
		expect(await page.locator("body").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		expect(actions).not.toContain("prompt");
		expect(actions).not.toContain("dialog");
	} finally { channel.close(); }
});

test("错误轻提示只预览首行，详情保留原文，关闭后仍可继续编辑", async ({ page }) => {
	const channel = await replayTranscript(page, emptySnapshot());
	try {
		await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
		const message = `保存失败\nEACCES: permission denied\n${"错误明细 ".repeat(200)}`;
		channel.accept({ type: "feedback", message, tone: "error" });
		const toast = page.locator(".toast");
		await expect(toast.locator(".toast-message")).toHaveText("保存失败");
		await expect(toast).not.toContainText("错误明细");
		await expect(toast.getByRole("button", { name: "关闭通知" })).toBeInViewport();
		await toast.getByRole("button", { name: "详情", exact: true }).click();
		const detail = toast.locator("pre");
		await expect(detail).toHaveText(message);
		await expect(page.getByRole("dialog")).toHaveCount(0);
		expect(await page.locator("body").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		await page.keyboard.press("Escape");
		await expect(detail).toBeHidden();
		await toast.getByRole("button", { name: "关闭通知" }).click();
		await expect(toast).toHaveCount(0);
		await page.getByRole("textbox", { name: "消息", exact: true }).fill("继续编辑");
		await expect(page.locator(".app")).toBeVisible();
	} finally { channel.close(); }
});
