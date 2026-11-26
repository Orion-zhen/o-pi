import { test, expect } from "@playwright/test";
import type { GuiAction } from "../../../../src/gui/shared/protocol/actions.ts";
import type { GuiDialog, GuiSudoStage } from "../../../../src/gui/shared/protocol/state.ts";
import { guiSnapshot } from "../../helpers/snapshot-fixture.ts";
import { replayTranscript } from "../../helpers/transcript-live-fixture.ts";

test("sudo 审批原位切换密码和重试，保留展开的命令及草稿", async ({ page }) => {
	const channel = await replayTranscript(page, guiSnapshot());
	const command = `sudo ls ${"long-path/".repeat(30)}`;
	const approval: GuiDialog = { kind: "bashApproval", id: "approval", stage: { kind: "choose" }, title: "执行 Bash 命令", deadline: null,
		approval: { command, cwd: "/project", environment: [], items: [{ kind: "command", action: "execute", target: command, reason: "提升权限" }] },
		options: [{ label: "允许一次", value: "Allow once" }, { label: "拒绝", value: "Deny" }, { label: "拒绝并说明", value: "Deny with instruction" }] };
	const show = (stage: GuiSudoStage) => channel.accept({ type: "dialogs", value: [{ ...approval, stage }] });
	const password = (token: string, retry: boolean) => show({ kind: "prompting", token, account: "orion@devbox", retry });
	const responses: GuiAction[] = [];
	await page.route("**/api/action", async (route) => {
		const { value } = route.request().postDataJSON() as { value: GuiAction };
		if (value.action !== "dialog") { await route.fallback(); return; }
		responses.push(value);
		if (value.token === undefined) show({ kind: "waiting" });
		else if (value.token === "first") show({ kind: "submitted", account: "orion@devbox" });
		else channel.accept({ type: "dialogs", value: [] });
		await route.fulfill({ json: null });
	});
	try {
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("保留草稿");
		channel.accept({ type: "dialogs", value: [approval] });
		const dialog = page.getByRole("dialog", { name: approval.title });
		await dialog.getByRole("button", { name: "展开完整命令" }).click();
		const allow = dialog.getByRole("button", { name: "允许一次" });
		await allow.click();
		await expect(allow).toBeDisabled();
		const field = dialog.getByLabel("密码", { exact: true });
		await expect(field).toHaveCount(0);
		password("first", false);
		await expect(field).toBeFocused();
		await expect(field).toHaveAttribute("type", "password");
		await field.fill("test-only");
		await field.press("Enter");
		await expect(field).toBeDisabled();
		await expect(field).toHaveValue("");
		await expect(allow).toHaveCount(0);
		password("retry", true);
		await expect(dialog.getByRole("alert")).toContainText("认证未通过");
		await expect(field).toHaveValue("");
		await expect(field).toBeFocused();
		await expect(dialog.getByRole("button", { name: "收起命令" })).toHaveAttribute("aria-expanded", "true");
		await field.fill("not-submitted");
		await dialog.getByRole("button", { name: "取消" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(editor).toHaveValue("保留草稿");
		expect(responses).toEqual([{ action: "dialog", id: "approval", value: "Allow once" }, { action: "dialog", id: "approval", token: "first", value: "test-only" }, { action: "dialog", id: "approval", token: "retry", value: null }]);
	} finally { channel.close(); }
});
