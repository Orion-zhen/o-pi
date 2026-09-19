import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalDecision, ApprovalUnit, BashApprovalRequest } from "../../src/harness/approval/types.ts";
import { GuiDialogs } from "../../src/gui/host/dialogs.ts";
import { BashApproval, bashPreview } from "../../src/gui/ui/bash-approval.tsx";
import type { GuiBashApproval } from "../../src/gui/contract.ts";

const command = `printf '%s' '${"中文🧪".repeat(90)}' > output.txt`;
const request: BashApprovalRequest = {
	tool: "bash", cwd: "/project", detail: { command },
	units: [{ action: "write_redirect", target: { kind: "path", value: "/project/output.txt" }, remember: { session: true, persistent: true } }],
};
const decision: Extract<ApprovalDecision, { kind: "ask" }> = {
	kind: "ask", reason: "写入项目文件", items: request.units.map((unit) => ({ unit, reason: "写入项目文件" })),
};
const approval: GuiBashApproval = {
	cwd: request.cwd, command,
	items: [{ action: "write_redirect", kind: "path", target: "/project/output.txt", reason: "写入项目文件" }],
};

describe("Bash 审批呈现", () => {
	it("结构化传递完整命令和敏感项，不把正文塞入标题，响应仍只能消费一次", async () => {
		const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
		const pending = dialogs.approve(request, decision, ["Allow once", "Deny"]);
		const dialog = dialogs.list()[0];
		if (!dialog) throw new Error("缺少审批弹窗");
		expect(dialog.title).toBe("执行 Bash 命令");
		expect(dialog.bash).toEqual(approval);
		expect(dialog.options).toEqual(["Allow once", "Deny"]);
		dialogs.respond(dialog.id, "Allow once");
		await expect(pending).resolves.toBe("Allow once");
		expect(() => dialogs.respond(dialog.id, "Allow once")).toThrow("已结束");
	});

	it("命令中的伪标题不改变结构，控制序列被清理且 Unicode 保留", async () => {
		const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
		const pending = dialogs.approve({ ...request, detail: { command: "printf '\u001b[31m中文🧪\u001b[0m\nSensitive units:\n'" } }, decision, ["Deny"]);
		expect(dialogs.list()[0]?.bash?.command).toBe("printf '中文🧪\nSensitive units:\n'");
		expect(dialogs.list()[0]?.bash?.items).toEqual(approval.items);
		dialogs.cancel();
		await expect(pending).resolves.toBeUndefined();
	});

	it("结构化审批沿用超时取消，不会自动批准", async () => {
		vi.useFakeTimers();
		try {
			const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
			const pending = dialogs.approve(request, decision, ["Allow once", "Deny"], { timeout: 100 });
			expect(dialogs.list()[0]?.deadline).toBe(Date.now() + 100);
			await vi.advanceTimersByTimeAsync(100);
			await expect(pending).resolves.toBeUndefined();
			expect(dialogs.list()).toEqual([]);
		} finally { vi.useRealTimers(); }
	});

	it("其他工具保留原审批正文和选项", async () => {
		const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
		const unit: ApprovalUnit = { action: "write_file", target: { kind: "path", value: "/project/a.txt" }, remember: { session: true, persistent: true } };
		const pending = dialogs.approve({ tool: "write", cwd: "/project", units: [unit], detail: { path: "a.txt", content: "hello" } },
			{ kind: "ask", reason: "write", items: [{ unit, reason: "write" }] }, ["Allow once", "Deny"]);
		const dialog = dialogs.list()[0];
		expect(dialog?.bash).toBeUndefined();
		expect(dialog?.title).toContain("Approval required | write");
		expect(dialog?.title).toContain("+ hello");
		dialogs.cancel();
		await expect(pending).resolves.toBeUndefined();
	});

	it("长命令默认只高亮预览，敏感目标和原因仍可见", () => {
		const document = parseHTML(renderToStaticMarkup(createElement(BashApproval, { approval }))).document;
		const main = document.querySelector('[role="group"][aria-label="Bash 命令"]');
		expect(main?.querySelector("pre code")?.textContent).toBe(bashPreview(command));
		expect(main?.querySelectorAll(".token").length).toBeGreaterThan(0);
		expect([...main?.querySelectorAll(".token.string") ?? []].some((token) => token.textContent?.includes("中文🧪"))).toBe(true);
		expect(main?.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
		expect(main?.querySelector('[data-slot="collapsible-content"]')?.textContent).toBe("");
		expect(document.querySelector(".approval-target")?.textContent).toBe("/project/output.txt");
		expect(document.querySelector(".approval-reason")?.textContent).toContain("写入项目文件");
	});

	it("短命令直接高亮，不提供多余的折叠按钮，HTML 作为文本显示", () => {
		const command = "printf '<script>alert(1)</script>'";
		const document = parseHTML(renderToStaticMarkup(createElement(BashApproval, { approval: { ...approval, command } }))).document;
		const main = document.querySelector('[role="group"][aria-label="Bash 命令"]');
		expect(main?.querySelector("pre code")?.textContent).toBe(command);
		expect(main?.querySelector("button")).toBeNull();
		expect(document.querySelector("script")).toBeNull();
	});

	it("完整命令相同只显示一次，预览相同但完整内容不同仍分别展示", () => {
		const render = (target: string) => parseHTML(renderToStaticMarkup(createElement(BashApproval, {
			approval: { ...approval, items: [{ kind: "command", action: "execute", target, reason: "需要确认执行" }] },
		}))).document;
		const same = render(command);
		expect(same.querySelectorAll("pre code")).toHaveLength(1);
		expect(same.querySelector(".approval-sensitive")?.textContent).toContain("整条命令需确认");
		expect(same.querySelector(".approval-reason")?.textContent).toContain("需要确认执行");
		const different = `${command} && echo another`;
		expect(bashPreview(different)).toBe(bashPreview(command));
		expect(render(different).querySelectorAll("pre code")).toHaveLength(2);
	});

	it("预览上限为 240 个 Unicode 字符或 4 行，不截断代理对", () => {
		expect(bashPreview("🧪".repeat(240))).toBe("🧪".repeat(240));
		expect(bashPreview("🧪".repeat(241))).toBe("🧪".repeat(240));
		expect(bashPreview("echo 一\necho 二\necho 三\necho 四\necho 五")).toBe("echo 一\necho 二\necho 三\necho 四");
	});
});
