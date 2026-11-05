import { test, expect } from "@playwright/test";
import type { GuiAction } from "../../../../src/gui/shared/protocol/actions.ts";
import { guiModelFixture, guiSnapshot } from "../../helpers/snapshot-fixture.ts";
import { replayTranscript } from "../../helpers/transcript-live-fixture.ts";

function snapshot() {
	const model = guiModelFixture();
	return { ...guiSnapshot(), model, models: [model], modelScopeChanged: true };
}

test("错误通知去重并排队，查看完整错误时仍可编辑消息", async ({ page }) => {
	const channel = await replayTranscript(page, snapshot());
	try {
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("继续工作");
		const failure = "导出失败\nEACCES: permission denied, open '/workspace/report.md'";
		for (const message of [failure, failure, "无法打开链接"]) channel.accept({ type: "feedback", tone: "error", message });
		const toast = page.locator(".toast");
		await expect(toast).toHaveCount(1);
		await expect(toast.locator(".toast-message")).toHaveText("导出失败");
		await expect(toast.getByLabel("另有 1 条通知")).toBeVisible();
		await expect(editor).toBeFocused();
		await toast.getByRole("button", { name: "详情", exact: true }).click();
		await expect(toast.locator("pre")).toHaveText(failure);
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await editor.fill("查看详情时继续输入");
		await expect(editor).toBeFocused();
		await expect(toast.locator("pre")).toBeVisible();
		await toast.getByRole("button", { name: "关闭通知" }).click();
		await expect(toast).toContainText("无法打开链接");
		await toast.getByRole("button", { name: "关闭通知" }).click();
		await expect(toast).toHaveCount(0);
	} finally { channel.close(); }
});

test("模型保存失败可查看和复制完整错误，重试成功后清除反馈", async ({ page }) => {
	const channel = await replayTranscript(page, snapshot());
	let saves = 0;
	const failure = "模型配置未保存\nEACCES: permission denied, open '/workspace/models.json'\n    at writeFile (node:fs/promises:1208:14)\n    at saveConfig (/app/settings.ts:42:3)";
	await page.route("**/api/action", async (route) => {
		const { value } = route.request().postDataJSON() as { value: GuiAction };
		if (value.action !== "persistModels") { await route.fallback(); return; }
		saves++;
		if (saves === 1) await route.fulfill({ status: 500, body: failure });
		else { channel.accept({ type: "snapshot", value: { ...snapshot(), modelScopeChanged: false } }); await route.fulfill({ json: null }); }
	});
	try {
		await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
		if (page.viewportSize()?.width === 390) await page.getByRole("button", { name: "菜单", exact: true }).click();
		await page.getByRole("button", { name: "模型", exact: true }).click();
		const panel = page.getByRole("dialog", { name: "模型", exact: true });
		await panel.getByRole("button", { name: "保存常用模型", exact: true }).click();
		await expect(panel.getByRole("alert")).toHaveText(failure);
		await expect(panel.getByRole("alert")).toBeInViewport();
		expect(await panel.getByRole("alert").evaluate((element) => element.clientHeight <= Number.parseFloat(getComputedStyle(element).lineHeight) * 3 + 1)).toBe(true);
		await panel.getByRole("button", { name: "查看详情", exact: true }).click();
		await expect(panel.locator(".feedback-detail-content pre")).toHaveText(failure);
		await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
			writeText: async (text: string) => { document.documentElement.dataset.copied = text; },
		} }));
		await panel.getByRole("button", { name: "复制原文", exact: true }).click();
		await expect(page.locator("html")).toHaveAttribute("data-copied", failure);
		await expect(panel.getByRole("button", { name: "已复制", exact: true })).toBeVisible();
		await expect(page.locator(".toast")).toHaveCount(0);
		await panel.getByRole("button", { name: "保存常用模型", exact: true }).click();
		await expect(panel.getByRole("alert")).toHaveCount(0);
		await expect(panel).toContainText("已保存常用模型");
		await expect(page.locator(".toast")).toHaveCount(0);
		expect(saves).toBe(2);
	} finally { channel.close(); }
});

test("窄屏大字号下通知仍可关闭，截断内容可展开且不抢输入焦点", async ({ page }) => {
	const channel = await replayTranscript(page, snapshot());
	try {
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("继续工作");
		const message = "导出失败：EACCES: permission denied, open '/workspace/reports/monthly-usage-report.md'";
		channel.accept({ type: "feedback", tone: "error", message });
		const toast = page.locator(".toast");
		await expect(toast.locator(".toast-message")).toHaveText(message);
		await expect(editor).toBeFocused();
		if ((page.viewportSize()?.width ?? 0) >= 1024) {
			await expect(toast.getByRole("button", { name: "详情", exact: true })).toHaveCount(0);
			await page.getByRole("button", { name: "收起会话信息", exact: true }).click();
			await expect(toast).toBeInViewport({ ratio: 1 });
			await page.setViewportSize({ width: 390, height: 480 });
		}
		await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
		await expect(toast).toBeInViewport({ ratio: 1 });
		await expect(toast.getByRole("button", { name: "详情", exact: true })).toBeInViewport({ ratio: 1 });
		await expect(toast.getByRole("button", { name: "关闭通知" })).toBeInViewport();
		await toast.getByRole("button", { name: "详情", exact: true }).click();
		await expect(toast.locator("pre")).toHaveText(message);
		await page.keyboard.press("Escape");
		await expect(toast.getByRole("button", { name: "详情", exact: true })).toBeFocused();
		await toast.getByRole("button", { name: "关闭通知" }).click();
		await expect(toast).toHaveCount(0);
	} finally { channel.close(); }
});

test("导出成功通知自动消失，不打断消息编辑", async ({ page }) => {
	const channel = await replayTranscript(page, snapshot());
	try {
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("继续工作");
		await page.clock.install();
		channel.accept({ type: "feedback", tone: "success", message: "已导出 report.md" });
		const toast = page.locator(".toast");
		await expect(toast).toContainText("已导出 report.md");
		await expect(editor).toBeFocused();
		await page.mouse.move(0, 0);
		await page.clock.fastForward(4000);
		await expect(toast).toHaveCount(0);
		await expect(editor).toHaveValue("继续工作");
	} finally { channel.close(); }
});

test("会话短错误不重复折叠，收起后仍可辨认原因", async ({ page }) => {
	const channel = await replayTranscript(page, snapshot());
	try {
		const message = "HTTP 401\ninvalid_api_key";
		channel.accept({ type: "notices", value: [{ id: "auth-error", anchor: 0, type: "error", text: message }] });
		const notices = page.locator(".notices");
		await expect(notices.getByRole("alert")).toHaveText(message);
		await expect(notices.getByRole("button", { name: "查看详情", exact: true })).toHaveCount(0);
		await notices.locator(".notices-header > .disclosure-trigger").click();
		await expect(notices.locator(".notice-preview")).toHaveText(message);
		await expect(notices).toContainText("1 项错误");
		await expect(notices.getByRole("alert")).toHaveCount(0);
		await expect(page.locator(".toast")).toHaveCount(0);
	} finally { channel.close(); }
});

for (const choice of ["Deny", null]) test(`审批悬浮窗${choice === null ? "取消" : "拒绝"}后恢复草稿和焦点`, async ({ page }) => {
	const channel = await replayTranscript(page, snapshot());
	const responses: GuiAction[] = [];
	await page.route("**/api/action", async (route) => {
		const { value } = route.request().postDataJSON() as { value: GuiAction };
		if (value.action !== "dialog") { await route.fallback(); return; }
		responses.push(value);
		channel.accept({ type: "dialogs", value: [] });
		await route.fulfill({ json: null });
	});
	try {
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("保留草稿");
		channel.accept({ type: "dialogs", value: [{ id: "approval", kind: "bashApproval", title: "执行 Bash 命令",
			options: ["Allow once", "Deny"].map((value) => ({ label: value, value })), deadline: null,
			approval: { cwd: "/fixture", command: "printf 'report' > output.txt", items: [
				{ action: "write_redirect", kind: "path", target: "/fixture/output.txt", reason: "需要确认写入文件" },
			] },
		}] });
		const approval = page.getByRole("dialog", { name: "执行 Bash 命令", exact: true });
		await expect(approval).toBeVisible();
		await expect(approval.getByRole("group", { name: "Bash 命令", exact: true })).toContainText("printf 'report' > output.txt");
		await expect(approval.getByRole("region", { name: "需要确认的操作", exact: true })).toContainText("/fixture/output.txt");
		await approval.getByRole("button", { name: "Deny", exact: true }).focus();
		await page.keyboard.press("Tab");
		expect(await approval.evaluate((element) => element.contains(document.activeElement))).toBe(true);
		if (choice === null) await page.keyboard.press("Escape");
		else await approval.getByRole("button", { name: choice, exact: true }).click();
		await expect(approval).toHaveCount(0);
		await expect(editor).toHaveValue("保留草稿");
		await expect(editor).toBeFocused();
		expect(responses).toEqual([{ action: "dialog", id: "approval", value: choice }]);
	} finally { channel.close(); }
});
