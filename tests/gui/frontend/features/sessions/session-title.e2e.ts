import { test, expect } from "@playwright/test";
import type { GuiSessionActivity } from "../../../../../src/gui/shared/protocol/state.ts";
import { guiSnapshot } from "../../../helpers/snapshot-fixture.ts";
import { replayTranscript } from "../../../helpers/transcript-live-fixture.ts";

test("生成期间立即显示首条消息摘要，保留加载和完成动画", async ({ page }) => {
	await page.clock.install({ time: 0 });
	await page.clock.pauseAt(1000);
	const snapshot = guiSnapshot();
	const file = "/fixture/session.jsonl";
	const activity: GuiSessionActivity = {
		sessionId: snapshot.sessionId, path: file, cwd: snapshot.cwd,
		title: "", titleGeneration: "generating", state: "running", completedAt: 0, modified: new Date(0).toISOString(),
	};
	const channel = await replayTranscript(page, snapshot);
	try {
		channel.accept({ type: "activity", value: [activity] });
		await page.clock.runFor(1280);
		const title = page.locator(".sidebar .history-session .session-title-text");
		const display = title.locator(".session-title-display");
		await expect(display).toHaveText("新会话");

		const summary = "检查工作区中的文件";
		channel.accept({ type: "sessions", value: [{ path: file, cwd: activity.cwd, title: summary, modified: activity.modified }] });
		await page.clock.runFor(32);
		await expect(display).toHaveText(summary);
		await expect(title).toHaveAttribute("aria-busy", "true");
		await expect(title).toHaveClass(/animate-pulse/);

		const generated = "工作区检查";
		channel.accept({ type: "activity", value: [{ ...activity, title: generated, titleGeneration: "complete" }] });
		channel.accept({ type: "sessions", value: [{ path: file, cwd: activity.cwd, title: generated, modified: activity.modified }] });
		await page.clock.runFor(32);
		await expect(title).toHaveAttribute("aria-busy", "false");
		await expect(title).not.toHaveClass(/animate-pulse/);
		await expect(display).not.toHaveText(generated);
		await page.clock.runFor(1000);
		await expect(display).toHaveText(generated);
	} finally { channel.close(); }
});
