import { test, expect } from "@playwright/test";
import { buildBashApprovalRequest } from "../../../../src/harness/approval/request/bash/parse.ts";
import { GuiDialogs } from "../../../../src/gui/host/session/dialogs.ts";
import type { GuiAction } from "../../../../src/gui/shared/protocol/actions.ts";
import { guiSnapshot } from "../../helpers/snapshot-fixture.ts";
import { replayTranscript } from "../../helpers/transcript-live-fixture.ts";

test("拒绝推送并将说明返回给代理，原草稿不丢失", async ({ page }) => {
	const channel = await replayTranscript(page, guiSnapshot());
	const dialogs = new GuiDialogs((event) => channel.accept(event), () => 0, { get: () => "", set: () => {} });
	const command = "git push origin main";
	const request = await buildBashApprovalRequest(command, { command, cwd: "/project", env: {} }, { askpass: false });
	await page.route("**/api/action", async (route) => {
		const { value } = route.request().postDataJSON() as { value: GuiAction };
		if (value.action !== "dialog") return route.fallback();
		dialogs.respond(value);
		await route.fulfill({ json: null });
	});
	try {
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("保留草稿");
		const reason = "将提交推送到远端仓库。";
		const answer = dialogs.approve(request, { kind: "ask", reason, items: request.units.map((unit) => ({ unit, reason })) },
			["Allow once", "Allow for session", "Deny", "Deny with instruction"]);
		const dialog = page.getByRole("dialog", { name: "执行 Bash 命令" });
		await dialog.getByRole("button", { name: "拒绝并说明" }).click();
		const field = dialog.getByLabel("给 Agent 的说明");
		await expect(field).toBeFocused();
		await expect(dialog.getByRole("button", { name: "发送说明" })).toBeDisabled();
		const instruction = "先不要推送。\n请展示本地差异。";
		await field.fill(instruction);
		await dialog.getByRole("button", { name: "发送说明" }).click();
		await expect(dialog).toHaveCount(0);
		expect(await answer).toEqual({ kind: "denied", instruction });
		await expect(editor).toHaveValue("保留草稿");
		await expect(editor).toBeFocused();
	} finally { dialogs.cancel(); channel.close(); }
});
