import { test, expect } from "@playwright/test";
import type { GuiAction } from "../../src/gui/shared/protocol/actions.ts";
import { usageReport } from "./report-fixtures.ts";
import { guiSnapshot } from "./snapshot-fixture.ts";
import { replayTranscript } from "./transcript-live-fixture.ts";

type ConsumeAction = Extract<GuiAction, { action: "consumeCodexCredit" }>;
const refreshed = {
	...usageReport,
	providers: usageReport.providers.map((provider) => provider.id === "openai-codex" && provider.status === "ok" && provider.kind === "plan" ? {
		...provider, windows: provider.windows.map((window) => ({ ...window, usedPercent: 0 })),
		resetCredits: { availableCount: 2, credits: provider.resetCredits?.credits?.filter((credit) => credit.id !== "credit-1") },
	} : provider),
};

test("重置卡确认可取消，键盘确认后刷新额度和卡片", async ({ page }) => {
	const channel = await replayTranscript(page, guiSnapshot());
	await expect(page.getByRole("button", { name: "测试会话", exact: true })).toBeVisible();
	const release = Promise.withResolvers<void>();
	const requests: ConsumeAction[] = [];
	await page.route("**/api/action", async (route) => {
		const { value } = route.request().postDataJSON() as { value: GuiAction };
		if (value.action === "consumeCodexCredit") {
			requests.push(value);
			await release.promise;
			channel.accept({ type: "panel", panel: { kind: "usage", value: refreshed } });
			await route.fulfill({ json: { outcome: "reset", refreshed: true } });
			return;
		}
		await route.fulfill({ status: 204 });
	});
	try {
		channel.accept({ type: "panel", panel: { kind: "usage", value: usageReport } });
		const panel = page.getByRole("dialog", { name: "用量情况" });
		const button = panel.locator(".reset-credit-use").first();
		await button.hover();
		await expect(page.getByRole("tooltip")).toHaveText("使用这张重置卡");
		await button.click();
		await expect(button).toHaveText("确定");
		await page.keyboard.press("Escape");
		await expect(panel).toBeVisible();
		await expect(button).toHaveText("使用");
		await button.click();
		await panel.getByRole("heading", { name: "重置额度" }).click();
		await expect(button).toHaveText("使用");
		expect(requests).toHaveLength(0);
		await button.focus();
		await page.keyboard.press("Enter");
		await expect(button).toHaveText("确定");
		await page.keyboard.press("Enter");
		await expect(button).toHaveText("使用中");
		for (const control of await panel.locator(".reset-credit-use").all()) await expect(control).toBeDisabled();
		await expect(panel.getByRole("button", { name: "刷新", exact: true })).toBeDisabled();
		expect(requests).toEqual([{ action: "consumeCodexCredit", creditId: "credit-1", requestId: expect.any(String) }]);
		release.resolve();
		await expect(panel.locator(".reset-credits li")).toHaveCount(2);
		await expect(panel.getByText("重置卡已使用，Codex 额度已重置。")).toBeVisible();
		await expect(panel.getByRole("region", { name: "Codex", exact: true }).locator("meter")).toHaveAttribute("value", "100");
		await expect(panel.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
		expect(requests).toHaveLength(1);
		await page.keyboard.press("Escape");
		await expect(panel).not.toBeVisible();
	} finally { release.resolve(); channel.close(); }
});

test("重置卡在桌面、手机和大字号下不遮挡，按钮右对齐", async ({ page }) => {
	const channel = await replayTranscript(page, guiSnapshot());
	await expect(page.getByRole("button", { name: "测试会话", exact: true })).toBeVisible();
	try {
		channel.accept({ type: "panel", panel: { kind: "usage", value: usageReport } });
		const panel = page.getByRole("dialog", { name: "用量情况" });
		await expect(panel.locator(".reset-credit-use").first()).toBeVisible();
		for (const fontSize of ["100%", "200%"]) {
			await page.evaluate((size) => { document.documentElement.style.fontSize = size; }, fontSize);
			await expect.poll(() => panel.evaluate((element) => {
				const rows = Array.from(element.querySelectorAll(".reset-credit-row"));
				return element.scrollWidth <= element.clientWidth && rows.every((row) => {
					const button = row.querySelector("button");
					if (!button) return false;
					const bounds = row.getBoundingClientRect(), action = button.getBoundingClientRect();
					return row.scrollWidth <= row.clientWidth && Math.abs(bounds.right - action.right) < 1
						&& Array.from(row.querySelectorAll("dl")).every((field) => {
							const rect = field.getBoundingClientRect();
							return rect.right <= action.left || rect.bottom <= action.top;
						});
				});
			})).toBe(true);
		}
	} finally { channel.close(); }
});
