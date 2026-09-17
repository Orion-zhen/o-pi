import { expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelRequest, ModelResponse } from "../cli/model-server.ts";
import type { GuiAction } from "../../src/gui/contract.ts";

export function transcriptPhaseResponse(request: ModelRequest): ModelResponse | undefined {
	const phase = JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content)?.match(/验证阶段 ([ABC])/)?.[1];
	if (!phase) return undefined;
	if (request.messages.at(-1)?.role === "tool") return { text: `阶段 ${phase} 完成` };
	return {
		thinking: `检查阶段 ${phase}`,
		text: `开始阶段 ${phase}`,
		tool: "bash",
		args: { command: `printf 'phase-${phase}-ready\\n'; while [ ! -f phase-${phase}.release ]; do sleep 0.05; done; printf 'phase-${phase}-done\\n'${phase === "C" ? "" : "; exit 1"}` },
	};
}

async function steer(page: Page, text: string) {
	// 输入器默认发送 follow-up，通过同一个公开接口提交引导消息。
	await page.evaluate(async (text) => {
		const action = { action: "prompt", text, images: [], behavior: "steer" } satisfies GuiAction;
		if (window.opi) await window.opi.send(action);
		else {
			const response = await fetch("/api/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
			if (!response.ok) throw new Error(await response.text());
		}
	}, text);
}

export async function exerciseTranscriptPhases(page: Page, cwd: string) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const send = page.getByRole("button", { name: "发送", exact: true });
	const replies = page.locator(".assistant-reply");
	const first = replies.nth(0);
	const process = first.locator(".reply-process");
	const toggle = process.locator(":scope > .disclosure-trigger");
	await editor.fill("验证阶段 A");
	await send.click();
	await expect(first.locator(".tool-activity")).toHaveAttribute("data-state", "running");
	await expect(process).toHaveAttribute("data-state", "open");
	await first.locator(".tool-activity .activity-summary").click();
	await expect(first.locator('pre[aria-label="输出"]')).toContainText("phase-A-ready");

	await editor.fill("验证阶段 B");
	await send.click();
	await expect(page.locator(".queue")).toContainText("验证阶段 B");
	await expect(replies).toHaveCount(1);
	await expect(process).toHaveAttribute("data-state", "open");
	await page.getByRole("button", { name: "清空队列", exact: true }).click();
	await toggle.click();
	await steer(page, "验证阶段 B");
	await expect(page.locator(".queue")).toContainText("验证阶段 B");
	await expect(process).toHaveAttribute("data-state", "closed");
	await toggle.click();
	await page.locator(".transcript").evaluate((element) => { element.scrollTop = 0; });
	await writeFile(path.join(cwd, "phase-A.release"), "");

	const second = replies.nth(1);
	await expect(second.locator(".tool-activity")).toHaveAttribute("data-state", "running");
	await expect(second.locator(".reply-process")).toHaveAttribute("data-state", "open");
	await expect(process).toHaveAttribute("data-state", "closed");
	await expect(first).toHaveAttribute("data-state", "continued");
	await expect(first.locator(".reply-outcome")).toHaveText("已接续");
	await expect.poll(() => page.locator(".transcript").evaluate((element) => element.scrollTop)).toBeLessThan(4);
	await toggle.click();
	await expect(first.locator(".tool-activity .activity-summary")).toHaveAttribute("aria-expanded", "true");
	await expect(first.locator(".tool-activity")).toHaveAttribute("data-state", "failed");
	await steer(page, "验证阶段 C");
	await writeFile(path.join(cwd, "phase-B.release"), "");

	const third = replies.nth(2);
	await expect(third.locator(".tool-activity")).toHaveAttribute("data-state", "running");
	await expect(second.locator(".reply-process")).toHaveAttribute("data-state", "closed");
	await expect(process).toHaveAttribute("data-state", "open");
	await expect(third.locator(".reply-process")).toHaveAttribute("data-state", "open");
	const failedTool = second.locator(".tool-activity");
	await expect(failedTool).toHaveAttribute("data-state", "failed");
	await expect(failedTool.locator(".activity-summary")).toHaveAttribute("aria-expanded", "false");
	await second.locator(".reply-process > .disclosure-trigger").click();
	await expect(failedTool.locator(".activity-error")).toBeVisible();
	await expect(failedTool.locator(".activity-body")).not.toBeVisible();
	await failedTool.locator(".activity-summary").click();
	await expect(failedTool.locator(".activity-body")).toBeVisible();
	await writeFile(path.join(cwd, "phase-C.release"), "");
	await expect(third.locator(".reply-answer")).toHaveText("阶段 C 完成");
	await expect(third.locator(".reply-process")).toHaveAttribute("data-state", "closed");
	await expect(process).toHaveAttribute("data-state", "open");

	await editor.fill("验证停止输出");
	await send.click();
	const stopped = replies.nth(3);
	await expect(stopped.locator(".tool-activity")).toHaveAttribute("data-state", "running");
	await page.getByRole("button", { name: "停止", exact: true }).click();
	await expect(stopped).not.toHaveAttribute("data-state", "running");
	await expect(stopped.locator(".reply-process")).toHaveAttribute("data-state", "closed");
	await expect(stopped.locator(".reply-outcome")).toBeVisible();
	await stopped.locator(".reply-process > .disclosure-trigger").click();
	await expect(stopped.locator(".tool-activity")).toBeVisible();
	await expect(process).toHaveAttribute("data-state", "open");

	await page.reload();
	await expect(replies).toHaveCount(4);
	await expect(page.locator('.reply-process[data-state="open"]')).toHaveCount(0);
	await expect(first).toHaveAttribute("data-state", "continued");
	await expect(second).toHaveAttribute("data-state", "continued");
	await expect(failedTool.locator(".activity-summary")).toHaveAttribute("aria-expanded", "false");
	await expect(stopped.locator(".reply-outcome")).toBeVisible();
}
