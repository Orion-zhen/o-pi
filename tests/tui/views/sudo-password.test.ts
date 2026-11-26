import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { buildBashApprovalRequest } from "../../../src/harness/approval/request/bash/parse.ts";
import { openApprovalDialog } from "../../../src/tui/views/approval/dialog.ts";
import { requestSudoPassword } from "../../../src/tui/views/approval/sudo-password.ts";
import { dialogUi } from "../../helpers/tui-dialog.ts";

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("终端 sudo 认证", () => {
	it("允许一次后按需索密，输入不回显，重试不沿用上次密码", async () => {
		const open = vi.fn((dialog: Component) => dialog.handleInput?.("\r"));
		const ui = dialogUi(open);
		const request = await buildBashApprovalRequest("sudo id", { cwd: "/", command: "sudo id", env: {} }, { askpass: true });
		const decision = { kind: "ask" as const, reason: "sudo", items: request.units.map((unit) => ({ unit, reason: "sudo" })) };
		const response = await openApprovalDialog(ui, request, decision, ["Allow once", "Deny", "Deny with instruction"], undefined, "call");
		if (typeof response !== "object") throw new Error("缺少 sudo 认证");
		const signal = new AbortController().signal;
		for (const [retry, text] of [[false, "first"], [true, "second"]] as const) {
			open.mockImplementationOnce((dialog) => {
				const prompt = dialog.render(52).join("\n");
				expect(prompt.includes("Try again")).toBe(retry);
				dialog.handleInput?.(`\x1b[200~${text}\x1b[201~`);
				expect(dialog.render(52).join("\n")).toBe(prompt);
				dialog.handleInput?.("\r");
			});
			await expect(response.askpass(retry, signal)).resolves.toBe(text);
		}
	});

	it.each(["Esc", "中止命令"])("%s 不提交已输入的密码", async (end) => {
		const controller = new AbortController();
		const ui = dialogUi((dialog) => {
			dialog.handleInput?.("test-only");
			if (end === "Esc") dialog.handleInput?.("\x1b");
			else controller.abort();
		});
		await expect(requestSudoPassword(ui, false, controller.signal)).resolves.toBeUndefined();
	});
});
