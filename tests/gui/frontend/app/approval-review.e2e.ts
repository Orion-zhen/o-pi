import { expect, test } from "@playwright/test";
import type { GuiDialog } from "../../../../src/gui/shared/protocol/state.ts";
import { guiSnapshot } from "../../helpers/snapshot-fixture.ts";
import { replayTranscript } from "../../helpers/transcript-live-fixture.ts";

test("用户查看完整 AI 拒绝意见后，仍可手动允许本次写入", async ({ page }) => {
	const channel = await replayTranscript(page, guiSnapshot());
	try {
		const approval: GuiDialog = { kind: "toolApproval", id: "review", title: "写入文件", stage: { kind: "choose", review: { kind: "running" } },
			deadline: Date.now() + 30000, reason: "确认写入",
			approval: { cwd: "/project", tool: "write", detail: { path: "notes.md", content: "# 发布说明" } },
			options: [{ value: "Allow once", label: "允许一次" }, { value: "Allow for session", label: "本会话允许" }, { value: "Deny", label: "拒绝" }, { value: "Deny with instruction", label: "拒绝并说明" }] };
		channel.accept({ type: "dialogs", value: [approval] });
		const dialog = page.getByRole("dialog", { name: "写入文件" });
		await expect(dialog.getByRole("region", { name: "调用详情" })).toContainText("# 发布说明");
		const allow = dialog.getByRole("button", { name: "允许一次", exact: true });
		await allow.focus();
		const reason = "用户只要求预览发布说明。\n写入 notes.md 会覆盖已有草稿。\n建议先检查差异，再决定是否写入。";
		const start = Date.now();
		channel.accept({ type: "dialogs", value: [{ ...approval, deadline: null, stage: { kind: "choose", review: { kind: "ready", decision: "deny", reason, start, end: start + 30000 } } }] });
		await expect(dialog.getByRole("button", { name: "拒绝", exact: true })).toHaveAccessibleDescription(/AI 建议拒绝/);
		await expect(allow).toBeFocused();
		const expand = dialog.getByRole("button", { name: "完整 AI 意见" });
		await expand.click();
		await expect(page.getByRole("dialog", { name: "完整 AI 意见" })).toHaveText(reason);
		await page.keyboard.press("Escape");
		await expect(expand).toBeFocused();
		const [request] = await Promise.all([page.waitForRequest(req => req.url().endsWith("/api/action")), allow.click()]);
		expect(request.postDataJSON().value).toMatchObject({ action: "dialog", id: approval.id, value: "Allow once" });
	} finally { channel.close(); }
});
