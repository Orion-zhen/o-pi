import { test, expect } from "@playwright/test";
import { usageReport } from "./report-fixtures.ts";
import { guiSnapshot } from "./snapshot-fixture.ts";
import { replayTranscript } from "./transcript-live-fixture.ts";

test("DeepSeek 主余额位于分项上方，分项在宽屏并排、窄屏堆叠且不溢出", async ({ page }) => {
	const channel = await replayTranscript(page, guiSnapshot());
	try {
		await expect(page.getByRole("button", { name: "测试会话", exact: true })).toBeVisible();
		channel.accept({ type: "panel", panel: { kind: "usage", value: usageReport } });
		const card = page.getByRole("region", { name: "DeepSeek", exact: true });
		await expect(card).toBeVisible();
		for (const width of [1200, 320]) {
			await page.setViewportSize({ width, height: 844 });
			await expect.poll(() => card.evaluate((element) => {
				const rect = (label: string) => {
					const term = Array.from(element.querySelectorAll("dt")).find((item) => item.textContent === label);
					if (!term?.parentElement) throw new Error(`缺少 ${label}`);
					return term.parentElement.getBoundingClientRect();
				};
				const total = rect("可用余额");
				const toppedUp = rect("充值余额");
				const granted = rect("赠金余额");
				return {
					totalAbove: total.bottom <= toppedUp.top,
					sideBySide: Math.abs(toppedUp.top - granted.top) < 1 && toppedUp.right <= granted.left,
					stacked: toppedUp.bottom <= granted.top && Math.abs(toppedUp.left - granted.left) < 1,
					noOverflow: element.scrollWidth <= element.clientWidth,
				};
			})).toEqual({ totalAbove: true, sideBySide: width === 1200, stacked: width === 320, noOverflow: true });
		}
	} finally { channel.close(); }
});
