import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalDecision, ApprovalUnit, ShellApprovalRequest } from "../../../../../../src/harness/approval/types.ts";
import { buildBashApprovalRequest } from "../../../../../../src/harness/approval/request/bash/parse.ts";
import { buildPowerShellApprovalRequest } from "../../../../../../src/harness/approval/request/powershell.ts";
import { evaluateShellGatePolicy } from "../../../../../../src/harness/approval/rules/policy.ts";
import { SessionApprovalStore } from "../../../../../../src/harness/approval/rules/store.ts";
import { GuiDialogs } from "../../../../../../src/gui/host/session/dialogs.ts";
import { ShellApproval } from "../../../../../../src/gui/frontend/features/chat/tools/shell-approval.tsx";
import type { GuiShellApproval } from "../../../../../../src/gui/shared/protocol/state.ts";

const command = `printf '%s' '${"中文🧪".repeat(90)}' > output.txt`;
const request: ShellApprovalRequest = {
	tool: "bash", pipelines: [], allowSessionMemory: true, cwd: "/project", detail: { command },
	units: [{ action: "write_redirect", target: { kind: "path", value: "/project/output.txt" }, remember: true }],
};
const decision: Extract<ApprovalDecision, { kind: "ask" }> = {
	kind: "ask", reason: "写入项目文件", items: request.units.map((unit) => ({ unit, reason: "写入项目文件" })),
};
const approval: GuiShellApproval = {
	shell: "bash", cwd: request.cwd, command, environment: [],
	items: [{ action: "write_redirect", kind: "path", target: "/project/output.txt", reason: "写入项目文件" }],
};

describe("Shell 审批呈现", () => {
	it("结构化传递完整命令和敏感项，不把正文塞入标题，响应仍只能消费一次", async () => {
		const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
		const pending = dialogs.approve(request, decision, ["Allow once", "Allow for session", "Deny", "Deny with instruction"]);
		const dialog = dialogs.list()[0];
		if (dialog?.kind !== "shellApproval") throw new Error("缺少审批弹窗");
		expect(dialog.approval).toEqual(approval);
		expect(dialog.options).toEqual([
			{ label: "允许一次", value: "Allow once" }, { label: "本会话允许", value: "Allow for session" },
			{ label: "拒绝", value: "Deny" }, { label: "拒绝并说明", value: "Deny with instruction" },
		]);
		dialogs.respond({ id: dialog.id, value: "Allow once" });
		await expect(pending).resolves.toEqual({ kind: "approved" });
		expect(() => dialogs.respond({ id: dialog.id, value: "Allow once" })).toThrow();
	});

	it("PowerShell 的命令和语法标识通过同一审批面板传递", async () => {
		const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
		const command = "git push origin main";
		const request = await buildPowerShellApprovalRequest(command, { command, cwd: "/project", env: {} });
		const reason = "确认推送到远端";
		const pending = dialogs.approve(request, { kind: "ask", reason, items: request.units.map((unit) => ({ unit, reason })) },
			["Allow once", "Allow for session", "Deny", "Deny with instruction"]);
		const [dialog] = dialogs.list();
		if (dialog?.kind !== "shellApproval") throw new Error("缺少命令审批弹窗");
		expect(dialog.title).toBe("执行 PowerShell 命令");
		const document = parseHTML(renderToStaticMarkup(createElement(ShellApproval, { approval: dialog.approval, reveal: vi.fn() }))).document;
		expect(document.querySelector("figure code.language-powershell")?.textContent).toBe(command);
		expect(document.querySelector(".approval-reason")?.textContent).toContain(reason);
		dialogs.respond({ id: dialog.id, value: "Deny" });
		await expect(pending).resolves.toEqual({ kind: "denied" });
	});

	it("整条 PowerShell 命令需确认时显示无法确定的源参数", async () => {
		const command = "Get-Content $report";
		const r = await buildPowerShellApprovalRequest(command, { command, cwd: "/project", env: {} });
		const { decision } = evaluateShellGatePolicy(r, { default_action: "allow", combinations: {}, facts: {
			review: { match_all: true, action: "ask", reason: "确认读取", commands: [] },
		} }, new SessionApprovalStore());
		if (decision.kind !== "ask") throw new Error("读取应当询问");
		const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
		const pending = dialogs.approve(r, decision, ["Allow once", "Deny"]);
		const [dialog] = dialogs.list();
		if (dialog?.kind !== "shellApproval") throw new Error("缺少审批弹窗");
		expect(dialog.approval.items).toMatchObject([{ target: command, reason: expect.stringMatching(/确认读取.*Unresolved argument at 1:13: \$report/u) }]);
		dialogs.cancel(); await pending;
	});

	it("免密 sudo 执行结束时关闭原审批，期间没有密码框", async () => {
		const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
		const request = await buildBashApprovalRequest("sudo id", { cwd: "/project", command: "sudo id", env: {} }, { askpass: true });
		const owner = { refreshDialogs() {} };
		const pending = dialogs.approve(request, { kind: "ask", reason: "sudo", items: request.units.map((unit) => ({ unit, reason: "sudo" })) }, ["Allow once", "Deny", "Deny with instruction"], undefined, "call");
		const [approval] = dialogs.list();
		if (!approval) throw new Error("缺少审批");
		dialogs.respond({ id: approval.id, value: "Allow once" }, owner);
		await expect(pending).resolves.toMatchObject({ kind: "approved" });
		expect(dialogs.sudoFor(owner)?.dialog).toMatchObject({ id: approval.id, stage: { kind: "waiting" } });
		dialogs.finishSudo("call");
		expect(dialogs.sudoFor(owner)).toBeUndefined();
	});

	it("命令中的伪标题不改变结构，控制序列被清理且 Unicode 保留", async () => {
		const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
		const pending = dialogs.approve({ ...request, detail: { command: "printf '\u001b[31m中文🧪\u001b[0m\nSensitive units:\n'" } }, decision, ["Deny"]);
		const [dialog] = dialogs.list();
		if (dialog?.kind !== "shellApproval") throw new Error("缺少审批弹窗");
		expect(dialog.approval.command).toBe("printf '中文🧪\nSensitive units:\n'");
		expect(dialog.approval.items).toEqual(approval.items);
		dialogs.cancel();
		await expect(pending).resolves.toEqual({ kind: "denied" });
	});

	it.each(["bash", "powershell"])("%s 敏感环境值可查看，默认视图和路径都隐藏原值", async (shell) => {
		const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
		const expression = shell === "bash" ? "${ACCESS_TOKEN#label-}" : "$env:ACCESS_TOKEN";
		const command = `${shell === "bash" ? "echo" : "Write-Output ok"} >"${expression}.log"`;
		const call = { cwd: "/project", command, env: { ACCESS_TOKEN: "label-private-value" } };
		const request = shell === "bash" ? await buildBashApprovalRequest(command, call, { askpass: true }) : await buildPowerShellApprovalRequest(command, call);
		const unit = request.units.find(({ action }) => action === "write_redirect");
		if (!unit) throw new Error("缺少重定向");
		const pending = dialogs.approve(request, { kind: "ask", reason: "target", items: [{ unit, reason: "target" }] }, ["Deny"]);
		const dialog = dialogs.list()[0];
		if (dialog?.kind !== "shellApproval") throw new Error("缺少审批弹窗");
		expect(JSON.stringify(dialogs.list())).not.toContain("private-value");
		expect(dialog.approval.items[0]?.target).toContain(expression);
		expect(dialogs.reveal(dialog.id).items[0]?.target).toContain("private-value.log");
		dialogs.cancel();
		await pending;
		expect(() => dialogs.reveal(dialog.id)).toThrow();
	});

	it("结构化审批沿用超时取消，不会自动批准", async () => {
		vi.useFakeTimers();
		try {
			const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
			const pending = dialogs.approve(request, decision, ["Allow once", "Deny"], { timeout: 100 });
			expect(dialogs.list()[0]?.deadline).toBe(Date.now() + 100);
			await vi.advanceTimersByTimeAsync(100);
			await expect(pending).resolves.toEqual({ kind: "denied" });
			expect(dialogs.list()).toEqual([]);
		} finally { vi.useRealTimers(); }
	});

	it("拒绝后说明超时只跳过说明，原审批响应失效", async () => {
		vi.useFakeTimers();
		try {
			const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
			const pending = dialogs.approve(request, decision, ["Allow once", "Deny with instruction"], { timeout: 100 });
			const [approval] = dialogs.list();
			if (!approval) throw new Error("缺少审批");
			await vi.advanceTimersByTimeAsync(80);
			dialogs.respond({ id: approval.id, value: "Deny with instruction" });
			await vi.advanceTimersByTimeAsync(20);
			expect(dialogs.list()[0]).toMatchObject({ id: approval.id, stage: { kind: "instruction" } });
			expect(() => dialogs.respond({ id: approval.id, value: "Allow once" })).toThrow();
			await vi.advanceTimersByTimeAsync(100);
			await expect(pending).resolves.toEqual({ kind: "denied" });
			expect(dialogs.list()).toEqual([]);
		} finally { vi.useRealTimers(); }
	});

	it("拒绝写入文件时可查看拟写入内容并跳过说明", async () => {
		const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
		const unit: ApprovalUnit = { action: "write_file", target: { kind: "path", value: "/project/a.txt" }, remember: true };
		const pending = dialogs.approve({ tool: "write", cwd: "/project", unit, detail: { path: "a.txt", content: "hello" } },
			{ kind: "ask", reason: "write", items: [{ unit, reason: "write" }] }, ["Allow once", "Deny with instruction"]);
		const [dialog] = dialogs.list();
		if (dialog?.kind !== "toolApproval") throw new Error("缺少文件审批");
		expect(dialog.title).toBe("写入文件");
		expect(dialog.reason).toBe("write");
		expect(dialog.approval.detail).toMatchObject({ content: "hello" });
		dialogs.respond({ id: dialog.id, value: "Deny with instruction" });
		const [instruction] = dialogs.list();
		if (instruction?.kind !== "toolApproval" || instruction.stage.kind !== "instruction") throw new Error("缺少说明阶段");
		dialogs.respond({ id: dialog.id, token: instruction.stage.token, value: null });
		await expect(pending).resolves.toEqual({ kind: "denied" });
	});

	it("长命令默认完整高亮，敏感目标和原因可见", () => {
		const document = parseHTML(renderToStaticMarkup(createElement(ShellApproval, { approval, reveal: vi.fn() }))).document;
		const main = document.querySelector("figure");
		expect(main?.querySelector("pre code")?.textContent).toBe(command);
		expect([...main?.querySelectorAll(".token.string") ?? []].some((token) => token.textContent?.includes("中文🧪"))).toBe(true);
		expect(main?.querySelector("button")).toBeNull();
		expect(document.querySelector(".approval-target")?.textContent).toBe("/project/output.txt");
		expect(document.querySelector(".approval-reason")?.textContent).toContain("写入项目文件");
		expect(document.querySelector(".approval-environment")).toBeNull();
	});

	it("短命令直接高亮，不提供多余的折叠按钮，HTML 作为文本显示", () => {
		const command = "printf '<script>alert(1)</script>'";
		const document = parseHTML(renderToStaticMarkup(createElement(ShellApproval, { approval: { ...approval, command }, reveal: vi.fn() }))).document;
		const main = document.querySelector("figure");
		expect(main?.querySelector("pre code")?.textContent).toBe(command);
		expect(main?.querySelector("button")).toBeNull();
		expect(document.querySelector("script")).toBeNull();
	});

	it("完整命令相同只显示一次，预览相同但完整内容不同仍分别展示", () => {
		const render = (fullCommand: string) => parseHTML(renderToStaticMarkup(createElement(ShellApproval, {
			reveal: vi.fn(), approval: { ...approval, command: fullCommand, items: [{ kind: "command", action: "execute", target: command, reason: "需要确认执行" }] },
		}))).document;
		const same = render(command);
		expect(same.querySelectorAll("pre code")).toHaveLength(1);
		expect(same.querySelector(".approval-reason")?.textContent).toContain("需要确认执行");
		expect(same.querySelector("figcaption")?.textContent).toBe("完整命令");
		const full = `${command} && cat output.txt`;
		expect([...render(full).querySelectorAll("figure")].map(block => [block.querySelector("figcaption")?.textContent, block.querySelector("code")?.textContent]))
			.toEqual([["需确认的子命令", command], ["完整命令", full]]);
	});
});
