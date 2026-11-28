import { expect, test } from "@playwright/test";
import { GuiDialogs } from "../../../../src/gui/host/session/dialogs.ts";
import type { GuiQuery } from "../../../../src/gui/shared/protocol/queries.ts";
import { buildBashApprovalRequest } from "../../../../src/harness/approval/request/bash/parse.ts";
import { guiSnapshot } from "../../helpers/snapshot-fixture.ts";
import { replayTranscript } from "../../helpers/transcript-live-fixture.ts";

test("展开相关变量不读取敏感值，收起后变量和目标重新隐藏", async ({ page }) => {
	const channel = await replayTranscript(page, guiSnapshot());
	const dialogs = new GuiDialogs((event) => channel.accept(event), () => 0, { get: () => "", set: () => {} });
	let reads = 0;
	await page.route("**/api/query", async (route) => {
		const { value } = route.request().postDataJSON() as { value: GuiQuery };
		if (value.query !== "approvalDetails") return route.fallback();
		reads++;
		await route.fulfill({ json: dialogs.reveal(value.id) });
	});
	try {
		const command = 'echo > "$OUT_DIR/${REPORT_TOKEN}${SUFFIX:-}${EXT:-.txt}"';
		const request = await buildBashApprovalRequest(command, { command, cwd: "/workspace/demo", env: { OUT_DIR: "reports", REPORT_TOKEN: "demo-only", SUFFIX: "" } }, { askpass: false });
		const unit = request.units.find(({ action }) => action === "write_redirect");
		if (!unit) throw new Error("缺少重定向目标");
		void dialogs.approve(request, { kind: "ask", reason: "写入文件", items: [{ unit, reason: "需要确认写入目标。" }] }, ["Allow once", "Deny", "Deny with instruction"]);
		const dialog = page.getByRole("dialog", { name: "执行 Bash 命令" });
		const toggle = dialog.getByRole("button", { name: /相关变量.*4 项/ });
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await toggle.click();
		for (const text of ["reports", "已隐藏", "空字符串", "未设置"]) await expect(dialog.getByRole("definition").getByText(text, { exact: true })).toBeVisible();
		expect(reads).toBe(0);
		await dialog.getByRole("button", { name: "查看敏感值" }).click();
		await expect(dialog.getByRole("definition").getByText("demo-only")).toBeVisible();
		await expect(dialog.getByRole("region", { name: "调用详情" })).toContainText("reports/demo-only.txt");
		await toggle.click();
		await expect(dialog).not.toContainText("demo-only");
		await toggle.click();
		await expect(dialog.getByRole("definition").getByText("已隐藏")).toBeVisible();
		expect(reads).toBe(1);
	} finally { dialogs.cancel(); channel.close(); }
});
